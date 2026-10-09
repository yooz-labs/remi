import Foundation

/// Exact scalar policy from shared/src/display-text.ts. The signed payload stays unchanged.
public enum PushDisplayText {
    public static func escape(_ text: String) -> String {
        var output = ""
        for scalar in text.unicodeScalars {
            let value = scalar.value
            let unsafe = (value <= 0x1f && value != 9 && value != 10) ||
                (0x7f...0x9f).contains(value) || value == 0xad || value == 0x061c || value == 0x180e ||
                (0x200b...0x200f).contains(value) || (0x2028...0x202e).contains(value) ||
                (0x2060...0x206f).contains(value) || value == 0xfeff || (0xe0000...0xe007f).contains(value)
            if unsafe {
                output += value <= 0xffff ? String(format: "\\u%04X", value) : "\\u{\(String(value, radix: 16).uppercased())}"
            } else { output.unicodeScalars.append(scalar) }
        }
        return output
    }
}
