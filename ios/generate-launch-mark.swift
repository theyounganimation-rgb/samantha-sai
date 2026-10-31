// Reuse the actual app-icon pixels, including its gradient and letterform.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let assets = ios.appendingPathComponent("SAI/Assets.xcassets")
let iconURL = assets.appendingPathComponent("AppIcon.appiconset/AppIcon.png")
guard let source = CGImageSourceCreateWithURL(iconURL as CFURL, nil),
      let icon = CGImageSourceCreateImageAtIndex(source, 0, nil),
      icon.width == 1024, icon.height == 1024,
      let mark = icon.cropping(to: CGRect(x: 175, y: 175, width: 674, height: 674)),
      let colorSpace = icon.colorSpace else { fatalError("Expected the original 1024px SAI icon") }

for scale in 1...3 {
    let size = 108 * scale
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: 0, space: colorSpace,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)
    context.addEllipse(in: bounds)
    context.clip()
    context.interpolationQuality = .high
    context.draw(mark, in: bounds)
    let suffix = scale == 1 ? "" : "@\(scale)x"
    let output = assets.appendingPathComponent("LaunchMark.imageset/LaunchMark\(suffix).png")
    let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(destination))
    print("\(output.lastPathComponent): \(size) × \(size), original icon artwork")
}
