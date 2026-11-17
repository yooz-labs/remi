import Foundation

/// Classifies oversized inbound envelopes before the general JSON decoder (#1313).
/// Small frames still reach the existing decoder. The connection does not yet dispatch image
/// replies to the strict image codec; that remains a prerequisite for the transfer owner.
/// A large image frame, or a large frame whose top-level type cannot be identified safely,
/// is refused. The scanner does not build a JSON object; Data may materialize a contiguous view.
enum ImageIngressPreflight {
    static let imageTypePrefixes = ["image_upload_", "image_insert_"]
    private static let imageTypePrefixLimit = imageTypePrefixes.map { $0.utf8.count }.max() ?? 0

    static func isImageType(_ type: String) -> Bool {
        imageTypePrefixes.contains { type.hasPrefix($0) }
    }

    /// Refuses oversized image envelopes before the general decoder sees their fields (#1313).
    /// Large non-image frames continue to the existing decoder.
    static func refuseOversizedImage(_ data: Data) throws {
        guard data.count > ImageStagingLimits.frameBytes else { return }
        try data.withUnsafeBytes { bytes in
            var scanner = FrameTypeScanner(bytes: bytes)
            try scanner.scan()
        }
    }

    /// Probes outgoing JSON without building a second JSON object.
    /// Input must be well-formed JSON from JSONEncoder or WireJSON.serialized(); this probe does
    /// not fully validate malformed input, which the receiving decoder must reject downstream.
    static func outgoingIsImage(_ data: Data) throws -> Bool {
        try data.withUnsafeBytes { bytes in
            var scanner = FrameTypeScanner(bytes: bytes)
            return try scanner.scanOutgoing()
        }
    }

    private struct FrameTypeScanner {
        private static let maxDepth = 512
        private static let typeKey: [UInt8] = Array("type".utf8)

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
                    let type = try string(limit: ImageIngressPreflight.imageTypePrefixLimit)
                    if type.prefixIsASCII, ImageIngressPreflight.isImageType(String(decoding: type.prefix, as: UTF8.self)) {
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

        /// Nested containers can be skipped with a depth counter because the caller supplies
        /// well-formed JSON from JSONEncoder or WireJSON.serialized().
        mutating func scanOutgoing() throws -> Bool {
            whitespace()
            guard peek == 0x7b else { return false }
            index += 1
            whitespace()
            if peek == 0x7d {
                index += 1
                whitespace()
                guard index == bytes.count else { throw WireFrameError.malformedJSON }
                return false
            }
            var foundType = false
            var image = false
            while true {
                let key = try string(limit: Self.typeKey.count)
                whitespace()
                try take(0x3a)
                whitespace()
                if key.prefixIsASCII, key.length == Self.typeKey.count, key.prefix == Self.typeKey {
                    guard !foundType else { throw WireFrameError.malformedJSON }
                    foundType = true
                    if peek == 0x22 {
                        let type = try string(limit: ImageIngressPreflight.imageTypePrefixLimit)
                        image = type.prefixIsASCII &&
                            ImageIngressPreflight.isImageType(String(decoding: type.prefix, as: UTF8.self))
                    } else {
                        try skipEncoderValue()
                    }
                } else {
                    try skipEncoderValue()
                }
                whitespace()
                if peek == 0x7d {
                    index += 1
                    whitespace()
                    guard index == bytes.count else { throw WireFrameError.malformedJSON }
                    return image
                }
                try take(0x2c)
                whitespace()
            }
        }

        private mutating func skipEncoderValue() throws {
            guard let first = peek else { throw WireFrameError.malformedJSON }
            if first == 0x22 { _ = try string(limit: 0); return }
            if first == 0x7b || first == 0x5b {
                var depth = 0
                while let byte = peek {
                    if byte == 0x22 { _ = try string(limit: 0); continue }
                    index += 1
                    if byte == 0x7b || byte == 0x5b { depth += 1 }
                    if byte == 0x7d || byte == 0x5d {
                        depth -= 1
                        if depth == 0 { return }
                    }
                }
                throw WireFrameError.malformedJSON
            }
            let start = index
            while let byte = peek, byte != 0x2c, byte != 0x7d,
                  byte != 0x20, byte != 0x09, byte != 0x0a, byte != 0x0d { index += 1 }
            guard index > start else { throw WireFrameError.malformedJSON }
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
