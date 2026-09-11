#ifndef Z_SELECTOR_FIXTURE_H
#define Z_SELECTOR_FIXTURE_H
typedef enum ZSelectorPhase { ZSelectorIdle = 0, ZSelectorRunning = 1 } ZSelectorPhase;
__attribute__((objc_root_class))
@interface ZSelectorTarget
- (void)registerTarget:(id)target selector:(SEL)selector;
- (void)wrongTarget:(int)target selector:(SEL)selector;
- (void)wrongSelector:(id)target selector:(int)selector;
- (SEL)callbackSelector;
@end
@interface ZSelectorLink : ZSelectorTarget
@end
#endif
