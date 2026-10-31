import AppKit
let output = CommandLine.arguments[1]
let size = 1024
let image = NSImage(size: NSSize(width:size,height:size))
image.lockFocus()
let frame = NSRect(x:0,y:0,width:size,height:size)
NSColor(calibratedRed:0.961,green:0.945,blue:0.922,alpha:1).setFill()
NSBezierPath(roundedRect:frame.insetBy(dx:35,dy:35),xRadius:220,yRadius:220).fill()
let orb = NSBezierPath(ovalIn:NSRect(x:175,y:175,width:674,height:674));orb.addClip()
let gradient = NSGradient(colors:[NSColor(calibratedRed:1,green:0.86,blue:0.64,alpha:1),NSColor(calibratedRed:0.9,green:0.42,blue:0.28,alpha:1),NSColor(calibratedRed:0.59,green:0.2,blue:0.16,alpha:1)])!
gradient.draw(from:NSPoint(x:375,y:710),to:NSPoint(x:750,y:230),options:[.drawsBeforeStartingLocation,.drawsAfterEndingLocation])
let attrs:[NSAttributedString.Key:Any] = [.font:NSFont(name:"Georgia-Italic",size:550)!, .foregroundColor:NSColor(calibratedWhite:1,alpha:0.93)]
NSString(string:"s").draw(at:NSPoint(x:376,y:228),withAttributes:attrs)
image.unlockFocus()
let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:output))
