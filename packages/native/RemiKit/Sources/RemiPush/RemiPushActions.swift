import CryptoKit
import Darwin
import Foundation
import UserNotifications

public struct VerifiedPushAction: Sendable, Equatable {
    public let identifier: String
    public let title: String
    public let value: String
    public let authenticationRequired: Bool
    fileprivate init(identifier: String, title: String, value: String, authenticationRequired: Bool) {
        self.identifier = identifier; self.title = title; self.value = value
        self.authenticationRequired = authenticationRequired
    }
    public static func == (lhs: Self, rhs: Self) -> Bool {
        Data(lhs.identifier.utf8) == Data(rhs.identifier.utf8) && Data(lhs.title.utf8) == Data(rhs.title.utf8) &&
            Data(lhs.value.utf8) == Data(rhs.value.utf8) && lhs.authenticationRequired == rhs.authenticationRequired
    }
}
public struct VerifiedPushActionSet: Sendable, Equatable {
    public let categoryIdentifier: String
    public let actions: [VerifiedPushAction]
    fileprivate init(categoryIdentifier: String, actions: [VerifiedPushAction]) {
        self.categoryIdentifier = categoryIdentifier; self.actions = actions
    }
    var category: UNNotificationCategory {
        UNNotificationCategory(identifier: categoryIdentifier, actions: actions.map {
            UNNotificationAction(identifier: $0.identifier, title: $0.title,
                options: $0.authenticationRequired ? [.authenticationRequired] : [])
        }, intentIdentifiers: [], options: [.customDismissAction])
    }
}
/// No public constructor: callers cannot mint a signed choice or display proof.
public struct VerifiedPushActionContext: Sendable {
    public let notification: VerifiedPushNotification
    public let action: VerifiedPushAction
    fileprivate let set: VerifiedPushActionSet
    fileprivate let title: String
    fileprivate let body: String
    fileprivate let subtitle: String
}

extension VerifiedPushNotification {
    public var nativeAnswerChoices: [VerifiedPushOption] { NativePushActionPolicy.choices(self) }
}
enum NativePushActionPolicy {
    static let prefix = "remi.secure.v2."
    static let maximumCategories = 128
    static let maximumObserved = 512
    // Matches the daemon's bounded permission-suggestion label contract.
    static let maximumActionTitleLength = 80
    static func acceptsUnverifiedCategories(_ categories: Set<UNNotificationCategory>) -> Bool {
        categories.allSatisfy { !$0.identifier.hasPrefix(prefix) }
    }
    static func title(_ option: VerifiedPushOption) -> String {
        let described = option.label + (option.description.map { " \u{2014} " + $0 } ?? "")
        return option.standingGrant == "addRules" && option.description != nil
            ? described + " · This session"
            : described
    }
    static func choices(_ notification: VerifiedPushNotification) -> [VerifiedPushOption] {
        guard notification.kind == .question else { return [] }
        let options = notification.options
        func yes(_ option: VerifiedPushOption) -> Bool { option.isYes && !option.isNo && option.standingGrant == nil }
        func no(_ option: VerifiedPushOption) -> Bool { option.isNo && !option.isYes && option.standingGrant == nil }
        if notification.category == "REMI_YN" {
            guard options.count == 2, yes(options[0]), no(options[1]) else { return [] }
        } else if notification.category == "REMI_YNA" {
            guard options.count == 3, yes(options[0]), no(options[2]), options[1].isYes, !options[1].isNo,
                  options[1].standingGrant == "addRules",
                  options[1].description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ||
                    options[1].label.hasSuffix(" for this session") else { return [] }
        } else { return [] }
        guard Set(options.map { Data($0.value.utf8) }).count == options.count else { return [] }
        for option in options {
            let rendered = title(option)
            guard !option.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  option.description == nil || option.description?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
                  rendered.count <= maximumActionTitleLength, rendered.unicodeScalars.allSatisfy({
                      $0.properties.generalCategory != .control && $0.properties.generalCategory != .format
                  }) else { return [] }
        }
        return options
    }
    static func set(_ notification: VerifiedPushNotification) throws -> VerifiedPushActionSet? {
        guard !notification.machine.authority.requiresAppUnlock else { return nil }
        let options = choices(notification)
        guard !options.isEmpty else { return nil }
        var tuple = Data()
        for part in [Data("remi-native-v2 actions".utf8), notification.machine.room,
                     notification.machine.machinePublicKey, notification.machine.authority.publicKey,
                     Data(notification.machine.authority.revision.utf8), notification.contentDigest] {
            guard part.count <= 65535 else { throw RemiPushError.invalid }
            tuple.append(contentsOf: [UInt8(part.count >> 8), UInt8(part.count & 255)]); tuple.append(part)
        }
        let hash = SHA256.hash(data: tuple).map { String(format: "%02x", $0) }.joined()
        let identifier = prefix + String(notification.expiresAt) + "." + hash
        // No is the first nondestructive action, including Watch Double Tap.
        let ordered = options.enumerated().sorted { lhs, rhs in
            lhs.element.isNo != rhs.element.isNo ? lhs.element.isNo : lhs.offset < rhs.offset
        }
        return .init(categoryIdentifier: identifier, actions: ordered.map {
            .init(identifier: identifier + ".a." + String($0.offset), title: title($0.element),
                  value: $0.element.value, authenticationRequired: $0.element.standingGrant != nil)
        })
    }
    static func expiry(_ identifier: String) -> Int64? {
        guard identifier.hasPrefix(prefix) else { return nil }
        let fields = identifier.dropFirst(prefix.count).split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 2, let expiry = Int64(fields[0]), String(expiry) == fields[0], expiry > 0,
              fields[1].count == 64, fields[1].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return expiry
    }
    /// Pure OS-boundary merge. Unknown categories are preserved, and identifiers
    /// are never reassigned to a different signed title/choice.
    static func merge(_ observed: Set<UNNotificationCategory>, adding: Set<UNNotificationCategory>,
                      now: Int64) throws -> Set<UNNotificationCategory> {
        guard observed.count <= maximumObserved, adding.count <= maximumCategories else { throw RemiPushError.invalid }
        let incoming = Dictionary(adding.map { ($0.identifier, $0) }, uniquingKeysWith: { first, _ in first })
        let foreign = observed.filter { expiry($0.identifier) == nil }
        let retained = observed.filter { category in
            guard let expiry = expiry(category.identifier) else { return false }
            return expiry > now && expiry - now <= 3600 && incoming[category.identifier] == nil
        }.sorted { left, right in
            let a = expiry(left.identifier) ?? 0, b = expiry(right.identifier) ?? 0
            return a == b ? left.identifier < right.identifier : a > b
        }
        let newSecureCount = incoming.keys.filter { expiry($0) != nil }.count
        let old = retained.prefix(max(0, maximumCategories - newSecureCount))
        let replacements = foreign.filter { incoming[$0.identifier] == nil }
        let merged = Set(replacements).union(old).union(adding)
        guard merged.count <= maximumObserved else { throw RemiPushError.invalid }
        return merged
    }
}

extension RemiPushStore {
    /// Classification consumes malformed secure markers but grants no authority.
    public static func isSecureNotification(content: UNNotificationContent, identifier: String? = nil) -> Bool {
        content.userInfo["remiPush"] != nil || content.categoryIdentifier.hasPrefix(NativePushActionPolicy.prefix) ||
            identifier?.hasPrefix(NativePushActionPolicy.prefix) == true
    }
    public func actionSet(for notification: VerifiedPushNotification) throws -> VerifiedPushActionSet? {
        try recheck(notification)
        return try NativePushActionPolicy.set(notification)
    }
    public func verifyAction(content: UNNotificationContent, identifier: String) throws -> VerifiedPushActionContext {
        guard let original = content.userInfo["remiPush"], JSONSerialization.isValidJSONObject(original) else { throw RemiPushError.invalid }
        let notification = try open(carrier: JSONSerialization.data(withJSONObject: original))
        guard let set = try actionSet(for: notification),
              Data(content.title.utf8) == Data(notification.title.utf8), Data(content.body.utf8) == Data(notification.body.utf8),
              content.subtitle.isEmpty, content.categoryIdentifier == set.categoryIdentifier,
              let action = set.actions.first(where: { Data($0.identifier.utf8) == Data(identifier.utf8) }) else { throw RemiPushError.changed }
        return .init(notification: notification, action: action, set: set, title: content.title, body: content.body, subtitle: content.subtitle)
    }
    public func recheckAction(_ context: VerifiedPushActionContext) throws {
        try recheck(context.notification)
        let reopened = try open(carrier: context.notification.originalCarrier)
        guard let current = try actionSet(for: reopened), current == context.set,
              Data(reopened.title.utf8) == Data(context.title.utf8), Data(reopened.body.utf8) == Data(context.body.utf8),
              context.subtitle.isEmpty, current.actions.contains(context.action) else { throw RemiPushError.changed }
    }
    public func publishActions(for notification: VerifiedPushNotification,
                               completion: @escaping @Sendable (VerifiedPushActionSet?) -> Void) {
        #if DEBUG
        // Owned fixtures never read or mutate the owner's OS category registry.
        guard !isOwnedTestStore else { completion(nil); return }
        #endif
        NativePushCategoryPublisher.queue.async {
            do {
                guard let set = try self.actionSet(for: notification) else { completion(nil); return }
                try NativePushCategoryPublisher.publish([set.category], lock: self.categoryLockURL,
                    validate: { try self.recheck(notification) })
                try self.recheck(notification)
                completion(set)
            } catch { completion(nil) }
        }
    }
    public func mergeNotificationCategories(_ categories: Set<UNNotificationCategory>,
                                            completion: @escaping @Sendable (Bool) -> Void) {
        #if DEBUG
        guard !isOwnedTestStore else { completion(false); return }
        #endif
        // Only verified publication may install a secure immutable identifier.
        guard NativePushActionPolicy.acceptsUnverifiedCategories(categories) else {
            completion(false); return
        }
        let batch = NativeCategoryBatch(categories)
        NativePushCategoryPublisher.queue.async {
            do { try NativePushCategoryPublisher.publish(batch.categories, lock: self.categoryLockURL, validate: {}); completion(true) }
            catch { completion(false) }
        }
    }
}

private final class NativeCategoryBatch: @unchecked Sendable {
    // UNNotificationCategory is immutable. This box owns it across queue hops.
    let categories: Set<UNNotificationCategory>
    init(_ categories: Set<UNNotificationCategory>) { self.categories = categories }
}
private final class NativeCategoryResult: @unchecked Sendable {
    let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Set<UNNotificationCategory>?
    func set(_ value: Set<UNNotificationCategory>) { lock.lock(); result = value; lock.unlock(); semaphore.signal() }
    func get() -> Set<UNNotificationCategory>? { lock.lock(); defer { lock.unlock() }; return result }
}
private enum NativePushCategoryPublisher {
    static let queue = DispatchQueue(label: "live.yooz.remi.native.categories", qos: .userInitiated)
    static func snapshot(_ center: UNUserNotificationCenter) throws -> Set<UNNotificationCategory> {
        let result = NativeCategoryResult()
        center.getNotificationCategories { result.set($0) }
        guard result.semaphore.wait(timeout: .now() + .seconds(1)) == .success, let value = result.get() else { throw RemiPushError.unavailable }
        return value
    }
    static func publish(_ categories: Set<UNNotificationCategory>, lock file: URL,
                        validate: () throws -> Void) throws {
        let descriptor = Darwin.open(file.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw RemiPushError.unavailable }
        defer { close(descriptor) }
        try NativePushFileProtection.file(file)
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK, ContinuousClock.now < deadline else { throw RemiPushError.unavailable }
            usleep(10_000)
        }
        defer { flock(descriptor, LOCK_UN) }
        try validate()
        let center = UNUserNotificationCenter.current()
        let observed = try snapshot(center)
        let merged = try NativePushActionPolicy.merge(observed, adding: categories, now: Int64(Date().timeIntervalSince1970))
        try validate()
        center.setNotificationCategories(merged)
        let current = try snapshot(center)
        for category in categories {
            guard let present = current.first(where: { $0.identifier == category.identifier }),
                  present.actions.count == category.actions.count else { throw RemiPushError.changed }
            for (actual, expected) in zip(present.actions, category.actions) {
                guard actual.identifier == expected.identifier, Data(actual.title.utf8) == Data(expected.title.utf8),
                      actual.options == expected.options else { throw RemiPushError.changed }
            }
        }
        try validate()
        // The file lease coordinates native app/NSE callers. OS get/set is not
        // atomic with unrelated writers; loss of a category remains availability
        // failure. An action always independently re-verifies its immutable ID.
    }
}
