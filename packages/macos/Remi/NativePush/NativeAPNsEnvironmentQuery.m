#import "NativeAPNsEnvironmentQuery.h"
#import <TargetConditionals.h>

#if TARGET_OS_OSX
#import <Security/SecTask.h>
#endif
#if !TARGET_OS_SIMULATOR && (!TARGET_OS_OSX || DEBUG)
#import <xpc/xpc.h>
// Exact official public extern, explicitly weak for older deployment targets.
extern const struct _xpc_dictionary_s _xpc_error_peer_code_signing_requirement __attribute__((weak_import));

static int ConfigureAPNsRequirement(xpc_connection_t client, const char *entitlement, const char *value) {
    if (@available(iOS 17.4, macOS 14.4, *)) {
        // Apple public LWCR schema: select the entitlement, then exact equality.
        xpc_object_t select = xpc_array_create_empty();
        xpc_array_append_value(select, xpc_int64_create(1));
        xpc_array_append_value(select, xpc_string_create(entitlement));
        xpc_object_t match = xpc_array_create_empty();
        xpc_array_append_value(match, xpc_int64_create(3));
        xpc_array_append_value(match, xpc_string_create(value));
        xpc_object_t query = xpc_array_create_empty();
        xpc_array_append_value(query, select); xpc_array_append_value(query, match);
        xpc_object_t entitlements = xpc_dictionary_create_empty();
        xpc_dictionary_set_value(entitlements, "$query", query);
        xpc_object_t constraint = xpc_dictionary_create_empty();
        xpc_dictionary_set_value(constraint, "entitlements", entitlements);
        return xpc_connection_set_peer_lightweight_code_requirement(client, constraint);
    }
    return -1;
}
#endif

#if !TARGET_OS_SIMULATOR && (!TARGET_OS_OSX || DEBUG)
static RemiAPNsQueryCancel QuerySelfPeer(const char *entitlement, BOOL production,
                                       void (^completion)(NSInteger)) {
    if (@available(iOS 17.4, macOS 14.4, *)) {} else { completion(-1); return ^{}; }
    if (&_xpc_error_peer_code_signing_requirement == NULL) { completion(-1); return ^{}; }
    dispatch_queue_t queue = dispatch_queue_create("live.yooz.remi.apns.entitlement", DISPATCH_QUEUE_SERIAL);
    __block BOOL done = NO;
    __block xpc_connection_t accepted = nil;
    __block void (^finish)(NSInteger) = nil;
    dispatch_async(queue, ^{
        if (done) return;
        xpc_connection_t listener = xpc_connection_create(NULL, queue);
        xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
            if (xpc_get_type(event) != XPC_TYPE_CONNECTION) return;
            xpc_connection_t peer = (xpc_connection_t)event;
            xpc_connection_set_target_queue(peer, queue);
            __weak xpc_connection_t weakPeer = peer;
            xpc_connection_set_event_handler(peer, ^(xpc_object_t request) {
                if (done || xpc_get_type(request) != XPC_TYPE_DICTIONARY ||
                    xpc_dictionary_get_uint64(request, "query") != 1) return;
                xpc_object_t reply = xpc_dictionary_create_reply(request);
                if (!reply) return;
                xpc_dictionary_set_uint64(reply, "query", 1);
                xpc_connection_t livePeer = weakPeer;
                if (livePeer) xpc_connection_send_message(livePeer, reply);
            });
            xpc_connection_activate(peer);
            if (done || accepted) { xpc_connection_cancel(peer); return; }
            accepted = peer;
        });
        xpc_connection_activate(listener);
        xpc_connection_t client = xpc_connection_create_from_endpoint(xpc_endpoint_create(listener));
        xpc_connection_set_target_queue(client, queue);
        xpc_connection_set_event_handler(client, ^(xpc_object_t event) { (void)event; });
        int status = ConfigureAPNsRequirement(client, entitlement, production ? "production" : "development");
        xpc_connection_activate(client);
        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
        finish = ^(NSInteger result) {
            if (done) return;
            // Disposal clears the last owner of this block. Retain the callback
            // locally before clearing finish so completion cannot use freed captures.
            void (^notify)(NSInteger) = [completion copy];
            done = YES;
            dispatch_source_set_event_handler(timer, ^{}); dispatch_source_cancel(timer);
            xpc_connection_set_event_handler(client, ^(xpc_object_t event) { (void)event; });
            if (accepted) xpc_connection_set_event_handler(accepted, ^(xpc_object_t event) { (void)event; });
            if (accepted) xpc_connection_cancel(accepted);
            xpc_connection_cancel(client); xpc_connection_cancel(listener);
            finish = nil;
            notify(result);
        };
        dispatch_source_set_event_handler(timer, ^{ if (finish) finish(-1); });
        dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), DISPATCH_TIME_FOREVER, 0);
        dispatch_activate(timer);
        if (status != 0) { finish(-1); return; }
        xpc_object_t request = xpc_dictionary_create_empty();
        xpc_dictionary_set_uint64(request, "query", 1);
        xpc_connection_send_message_with_reply(client, request, queue, ^(xpc_object_t reply) {
            if (!finish) return;
            if (&_xpc_error_peer_code_signing_requirement == NULL) { finish(-1); return; }
            if (reply == XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT) { finish(0); return; }
            if (xpc_get_type(reply) == XPC_TYPE_DICTIONARY && xpc_dictionary_get_uint64(reply, "query") == 1) {
                finish(1); return;
            }
            finish(-1);
        });
    });
    return ^{ dispatch_async(queue, ^{ if (finish) finish(-1); else done = YES; }); };
}
#endif

#if DEBUG && TARGET_OS_OSX
// Internal test entry for the same anonymous-XPC mechanics, never a selector
// used by production or exported to the bundled JavaScript bridge.
RemiAPNsQueryCancel RemiQueryAPNsSelfPeerForTesting(NSString *entitlement, BOOL production,
                                                 void (^completion)(NSInteger)) {
    if (![entitlement hasPrefix:@"live.yooz.remi.tests."] || entitlement.length > 128) {
        completion(-1); return ^{};
    }
    // The setup queue needs owned bytes after this NSString call returns.
    NSString *owned = [entitlement copy];
    RemiAPNsQueryCancel cancel = QuerySelfPeer(owned.UTF8String, production, ^(NSInteger result) {
        (void)owned;
        completion(result);
    });
    return [cancel copy];
}
#endif

RemiAPNsQueryCancel RemiQueryAPNsValue(BOOL production, void (^completion)(NSInteger)) {
#if TARGET_OS_SIMULATOR
    (void)production;
    completion(-1);
    return ^{};
#elif TARGET_OS_OSX
    dispatch_queue_t queue = dispatch_queue_create("live.yooz.remi.apns.entitlement", DISPATCH_QUEUE_SERIAL);
    __block BOOL done = NO;
    dispatch_async(queue, ^{
        if (done) return;
        SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
        CFErrorRef error = NULL;
        CFTypeRef value = task ? SecTaskCopyValueForEntitlement(task,
            CFSTR("com.apple.developer.aps-environment"), &error) : NULL;
        NSInteger result = -1;
        if (!error && value && CFGetTypeID(value) == CFStringGetTypeID()) {
            BOOL prod = CFEqual(value, CFSTR("production"));
            BOOL development = CFEqual(value, CFSTR("development"));
            if (prod || development) result = (production ? prod : development) ? 1 : 0;
        }
        if (value) CFRelease(value);
        if (error) CFRelease(error);
        if (task) CFRelease(task);
        done = YES;
        completion(result);
    });
    return ^{ dispatch_async(queue, ^{ done = YES; }); };
#else
    return QuerySelfPeer("aps-environment", production, completion);
#endif
}
