typedef struct ZSharedRecord { int value; } ZSharedRecord;
@protocol ZSharedProtocol
- (int)value;
@end
__attribute__((objc_root_class))
@interface ZSharedObject
- (ZSharedObject * _Nonnull)next;
- (ZSharedRecord)record;
@property int value;
@end
