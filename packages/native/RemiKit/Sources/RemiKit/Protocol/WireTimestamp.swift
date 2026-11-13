import Foundation

/// The wire's `YYYY-MM-DDTHH:mm:ss.sssZ` timestamp spelling, with one shared value-type style
/// instead of a formatter built per call.
enum WireTimestamp {
    private static let style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    static func string(from date: Date = Date()) -> String { date.formatted(style) }

    static func date(from text: String) -> Date? { try? Date(text, strategy: style) }
}
