// Convert the owner-supplied artwork without redrawing or cropping the logo.
import AppKit
let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../assets/sai-logo.jpg").standardizedFileURL
guard let image = NSImage(contentsOf: source),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot read canonical SAI logo")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
