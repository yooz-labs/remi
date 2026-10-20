import Foundation

public enum HarnessLaunchArguments {
    public static func model(_ value: String) -> [String] {
        let model = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.isEmpty ? [] : ["--model", model]
    }
}
