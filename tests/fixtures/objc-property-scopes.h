#import <Foundation/Foundation.h>

@interface ZPropertyScopeBase : NSObject
@property(nonatomic, readonly) int value;
@property(class, readonly) double value;
@property(nonatomic, readonly) int marker;
@property(nonatomic) int writableValue;
@property(nonatomic, readonly) NSRange span;
@property(nonatomic, readonly, nullable) NSString *caption;
@property(class, readonly, nonnull) ZPropertyScopeBase *shared;
@end

@interface ZPropertyScopeChild : ZPropertyScopeBase
@property(nonatomic, readonly) int value;
@property(class, readonly) int marker;
@end

@implementation ZPropertyScopeBase
- (int)value { return 11; }
+ (double)value { return 22.5; }
- (int)marker { return 31; }
- (NSRange)span { return NSMakeRange(2, 3); }
- (NSString * _Nullable)caption { return nil; }
+ (ZPropertyScopeBase * _Nonnull)shared {
    static ZPropertyScopeBase *value;
    if (value == nil) value = [[ZPropertyScopeBase alloc] init];
    return value;
}
@end

@implementation ZPropertyScopeChild
- (int)value { return 41; }
- (NSRange)span { return NSMakeRange(5, 7); }
+ (int)marker { return 51; }
@end
