#import <Foundation/Foundation.h>

@protocol ZUnsafeBindingDelegate <NSObject>
@end

@interface ZUnsafeBindingOwner : NSObject
@property(nonatomic, assign) id<ZUnsafeBindingDelegate> delegate;
@end
