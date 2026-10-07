// swift-tools-version: 6.2
// RemiKit: everything the native apps share that is not a screen (protocol models,
// identity, the connection, the multi-machine store) and RemiUI, the shared design
// system. See ../AGENTS.md.
import PackageDescription

let package = Package(
    name: "RemiKit",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "RemiKit", targets: ["RemiKit"]),
        .library(name: "RemiUI", targets: ["RemiUI"]),
    ],
    targets: [
        .target(name: "RemiKit"),
        .target(name: "RemiUI", dependencies: ["RemiKit"]),
        .testTarget(name: "RemiKitTests", dependencies: ["RemiKit"]),
    ]
)
