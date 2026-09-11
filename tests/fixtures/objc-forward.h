#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@class ZSubclassFixture;
@interface ZForwardFactory : NSObject
+ (ZSubclassFixture *)makeObject;
- (void)registerTarget:(id)target selector:(SEL)selector;
- (int)fire:(ZSubclassFixture *)object;
- (void)invalidate;
@end
NS_ASSUME_NONNULL_END
