#import "objc-forward.h"
#import "objc-subclass.h"
@implementation ZForwardFactory {
    id _target;
    SEL _selector;
}
+ (ZSubclassFixture *)makeObject { return [[ZSubclassFixture alloc] initWithValue:21]; }
- (void)registerTarget:(id)target selector:(SEL)selector { _target = target; _selector = selector; }
- (int)fire:(ZSubclassFixture *)object {
    typedef int (*Callback)(id, SEL, ZSubclassFixture *);
    return ((Callback)[_target methodForSelector:_selector])(_target, _selector, object);
}
- (void)invalidate { _target = nil; _selector = NULL; }
@end
