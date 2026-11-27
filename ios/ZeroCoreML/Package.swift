// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ZeroCoreML",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(
            name: "ZeroCoreML",
            targets: ["ZeroCoreML"]
        )
    ],
    targets: [
        .target(
            name: "ZeroCoreML",
            path: "Sources/ZeroCoreML",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency")
            ]
        ),
        .testTarget(
            name: "ZeroCoreMLTests",
            dependencies: ["ZeroCoreML"],
            path: "Tests/ZeroCoreMLTests"
        )
    ]
)
