#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

NS_ASSUME_NONNULL_BEGIN
typedef void (^RemiAPNsQueryCancel)(void);
// 1: exact match; 0: explicit mismatch; -1: missing/unsupported/error/timeout.
// The returned block cancels only this owned attempt, and is safe from any queue.
RemiAPNsQueryCancel RemiQueryAPNsValue(BOOL production, void (^completion)(NSInteger));
#if DEBUG && TARGET_OS_OSX
// Test-internal OS boundary: only synthetic absent entitlement names accepted.
RemiAPNsQueryCancel RemiQueryAPNsSelfPeerForTesting(NSString *entitlement, BOOL production,
                                                 void (^completion)(NSInteger));
#endif
NS_ASSUME_NONNULL_END
