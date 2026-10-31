import Foundation

/// Classifies oversized inbound envelopes before the general JSON decoder (#1313).
/// Small frames still go through the existing decoder and the image family's strict codec.
/// A large image frame, or a large frame whose top-level type cannot be identified safely,
/// is refused. The scanner reads the original Data in place and never builds a JSON object.
enum ImageIngressPreflight {
    enum Classification: Equatable {
        case bounded
        case nonImage
    }

    static func classify(_ data: Data) throws -> Classification {
        guard data.count > ImageStagingLimits.frameBytes else { return .bounded }
        return try data.withUnsafeBytes { bytes in
            var scanner = Scanner(bytes: bytes)
            try scanner.scan()
            return .nonImage
        }
    }

    private struct Scanner {
        private static let maxDepth = 512
        private static let typeKey: [UInt8] = Array("type".utf8)
        private static let uploadPrefix: [UInt8] = Array("image_upload_".utf8)
        private static let insertPrefix: [UInt8] = Array("image_insert_".utf8)

        let bytes: UnsafeRawBufferPointer
        var index = 0

        /// Only the first few ASCII bytes matter for either key or type comparison.
        private struct ShortString {
            var prefix: [UInt8] = []
            var length = 0
            var prefixIsASCII = true
        }

        mutating func scan() throws {
            whitespace()
            try take(0x7b) // {
            whitespace()
            guard peek != 0x7d else { throw WireFrameError.malformedJSON }
            var foundType = false
            while true {
                let key = try string(limit: Self.typeKey.count)
                whitespace()
                try take(0x3a) // :
                whitespace()
                if key.prefixIsASCII, key.length == Self.typeKey.count, key.prefix == Self.typeKey {
                    guard !foundType else { throw WireFrameError.malformedJSON }
                    foundType = true
                    let type = try string(limit: max(Self.uploadPrefix.count, Self.insertPrefix.count))
                    if type.prefixIsASCII,
                       type.prefix.starts(with: Self.uploadPrefix) || type.prefix.starts(with: Self.insertPrefix) {
                        throw WireFrameError.oversize
                    }
                } else {
                    try skipValue()
                }
                whitespace()
                if peek == 0x7d {
                    index += 1
                    whitespace()
                    guard foundType, index == bytes.count else { throw WireFrameError.malformedJSON }
                    return
                }
                try take(0x2c) // ,
                whitespace()
            }
        }

        private var peek: UInt8? { index < bytes.count ? bytes[index] : nil }

        private mutating func take(_ value: UInt8) throws {
            guard peek == value else { throw WireFrameError.malformedJSON }
            index += 1
        }

        private mutating func whitespace() {
            while let byte = peek, byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d { index += 1 }
        }

        private mutating func string(limit: Int) throws -> ShortString {
            try take(0x22) // "
            var result = ShortString()
            result.prefix.reserveCapacity(limit)
            while let byte = peek {
                index += 1
                if byte == 0x22 { return result }
                guard byte >= 0x20 else { throw WireFrameError.malformedJSON }
                var scalar = UInt32(byte)
                if byte == 0x5c { // backslash
                    guard let escaped = peek else { throw WireFrameError.malformedJSON }
                    index += 1
                    switch escaped {
                    case 0x22, 0x5c, 0x2f: scalar = UInt32(escaped)
                    case 0x62: scalar = 0x08
                    case 0x66: scalar = 0x0c
                    case 0x6e: scalar = 0x0a
                    case 0x72: scalar = 0x0d
                    case 0x74: scalar = 0x09
                    case 0x75:
                        scalar = 0
                        for _ in 0..<4 {
                            guard let hex = peek, let digit = Self.hex(hex) else { throw WireFrameError.malformedJSON }
                            index += 1
                            scalar = scalar * 16 + UInt32(digit)
                        }
                    default: throw WireFrameError.malformedJSON
                    }
                }
                if result.length < limit {
                    if scalar <= 0x7f { result.prefix.append(UInt8(scalar)) }
                    else { result.prefixIsASCII = false }
                }
                result.length += 1
            }
            throw WireFrameError.malformedJSON
        }

        private static func hex(_ byte: UInt8) -> UInt8? {
            switch byte {
            case 0x30...0x39: byte - 0x30
            case 0x41...0x46: byte - 0x41 + 10
            case 0x61...0x66: byte - 0x61 + 10
            default: nil
            }
        }

        /// Skips a non-type value without interpreting or allocating its contents. JSONDecoder
        /// still validates a non-image message after this guard. Delimiter mismatch and deeply
        /// nested input fail closed so malformed data cannot hide a later image type.
        private mutating func skipValue() throws {
            guard let first = peek else { throw WireFrameError.malformedJSON }
            if first == 0x22 { _ = try string(limit: 0); return }
            if first == 0x7b || first == 0x5b {
                var stack: [UInt8] = [first == 0x7b ? 0x7d : 0x5d]
                index += 1
                while let byte = peek {
                    if byte == 0x22 { _ = try string(limit: 0); continue }
                    index += 1
                    if byte == 0x7b || byte == 0x5b {
                        guard stack.count < Self.maxDepth else { throw WireFrameError.malformedJSON }
                        stack.append(byte == 0x7b ? 0x7d : 0x5d)
                    } else if byte == 0x7d || byte == 0x5d {
                        guard stack.popLast() == byte else { throw WireFrameError.malformedJSON }
                        if stack.isEmpty { return }
                    }
                }
                throw WireFrameError.malformedJSON
            }
            let start = index
            while let byte = peek, byte != 0x2c, byte != 0x7d,
                  byte != 0x20, byte != 0x09, byte != 0x0a, byte != 0x0d { index += 1 }
            guard index > start else { throw WireFrameError.malformedJSON }
        }
    }
}
