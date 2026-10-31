import SwiftUI
import SpriteKit

struct WatchOrb: View {
    @ObservedObject var call: WatchVoiceCall
    let mood: [String: Any]
    @StateObject private var scene = SAIOrbScene(size: CGSize(width: 400, height: 400))
    @Environment(\.isLuminanceReduced) private var dimmed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    private var moodKey: String { String(data: (try? JSONSerialization.data(withJSONObject: mood, options: .sortedKeys)) ?? Data(), encoding: .utf8) ?? "" }
    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height) / 0.78 * 0.94
            SpriteView(scene: scene, isPaused: dimmed || phase != .active, preferredFramesPerSecond: 24)
                .frame(width: size, height: size)
                .frame(width: geometry.size.width, height: geometry.size.height)
                .onAppear { scene.applyMood(mood); updateInputs() }
                .onChange(of: moodKey) { _, _ in scene.applyMood(mood) }
                .onChange(of: call.level) { _, _ in updateInputs() }
                .onChange(of: call.userLevel) { _, _ in updateInputs() }
                .onChange(of: call.state) { _, _ in updateInputs() }
                .onChange(of: call.muted) { _, _ in updateInputs() }
                .onChange(of: reduceMotion) { _, _ in updateInputs() }
        }.contentShape(Rectangle())
    }
    private func updateInputs() {
        scene.herLevel = call.level; scene.yourLevel = call.muted ? 0 : call.userLevel
        scene.thinking = ["thinking", "connecting"].contains(call.state.lowercased())
        scene.reduceMotion = reduceMotion
    }
}

/// The same fragment shader, palette, lighting and animation equations as public/orb.js + app.js.
/// SpriteKit supplies the Watch GPU surface; v_tex_coord replaces WebGL's normalized fragment position.
final class SAIOrbScene: SKScene, ObservableObject {
    var herLevel: Float = 0, yourLevel: Float = 0
    var thinking = false, reduceMotion = false
    private let sprite = SKSpriteNode(color: .white, size: CGSize(width: 400, height: 400))
    private var uniforms: [String: SKUniform] = [:]
    private var last: TimeInterval?
    private var elapsed = 0.0
    private var paint = SIMD3<Float>(206,96,66), want = SIMD3<Float>(206,96,66)
    private var energy: Float = 0.15, wantEnergy: Float = 0.15
    private var glow: Float = 0, swell: Float = 0, veil: Float = 0, drift: Float = 0, churn: Float = 0
    private var level: Float = 0, whose: Float = 0
    private static let palette = (try! JSONSerialization.jsonObject(with: Data(SAIOrbShader.paletteJSON.utf8))) as! [String: Any]

    override init(size: CGSize) {
        super.init(size: size)
        scaleMode = .aspectFit; backgroundColor = .black
        for name in SAIOrbShader.uniforms {
            if ["uSkyTop","uSkyHorizon","uCloud","uPaper"].contains(name) { uniforms[name] = SKUniform(name: name, vectorFloat3: SIMD3<Float>(0,0,0)) }
            else if name == "uFinger" { uniforms[name] = SKUniform(name: name, vectorFloat2: SIMD2<Float>(0,0)) }
            else { uniforms[name] = SKUniform(name: name, float: 0) }
        }
        sprite.shader = SKShader(source: SAIOrbShader.source, uniforms: SAIOrbShader.uniforms.compactMap { uniforms[$0] })
        sprite.position = CGPoint(x: size.width/2, y: size.height/2); sprite.size = size; addChild(sprite)
        render(t: 0, still: 1)
    }
    required init?(coder aDecoder: NSCoder) { fatalError("Use init(size:)") }
    func applyMood(_ mood: [String: Any]) {
        let colors = Self.palette["MOOD_COLORS"] as! [String: [Double]]
        let weights = Self.palette["WEIGHT"] as! [String: Double]
        let aroused = Self.palette["AROUSED"] as! [String]
        var scores: [String: Double] = [:], order: [String] = []
        if mood["ok"] as? Bool == true {
            for (key, factor) in [("current",1.0),("background",0.5)] {
                for item in mood[key] as? [[String: String]] ?? [] {
                    if let name = item["emotion"], let intensity = item["intensity"], let w = weights[intensity], colors[name] != nil {
                        if scores[name] == nil { order.append(name) }; scores[name] = max(scores[name] ?? 0,w*factor)
                    }
                }
            }
        }
        let ranked = order.sorted { scores[$0]! > scores[$1]! }.prefix(2)
        var sky = Self.palette["SETTLED"] as! [Double]
        if let first = ranked.first, let color = colors[first] {
            let mix = max(0.45,min(1,0.5+(scores[first]!-0.3)*1.8))
            sky = zip(sky,color).map { $0+($1-$0)*mix }
            if ranked.count == 2, let second = ranked.last, let other = colors[second] {
                sky = zip(sky,other).map { $0+($1-$0)*0.15*min(1,scores[second]!) }
            }
        }
        want = SIMD3<Float>(Float(sky[0].rounded()),Float(sky[1].rounded()),Float(sky[2].rounded()))
        let arousal = ranked.filter { aroused.contains($0) }.map { scores[$0]! }.max() ?? 0
        let low = ["low","strained"].contains(mood["wellbeing"] as? String ?? "")
        wantEnergy = ranked.isEmpty ? 0.15 : Float(min(1,0.15+arousal*0.6-(low ? 0.05 : 0)))
    }
    override func update(_ currentTime: TimeInterval) {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--watch-orb-reference") { return }
        #endif
        let dt = Float(min(0.05,max(0,currentTime-(last ?? currentTime)))); last = currentTime; elapsed += Double(dt)
        let heard = max(herLevel, yourLevel), yours = yourLevel > herLevel
        // 60 Hz web easing, normalized to the Watch's 24 Hz rendering cadence.
        let frames = dt*60
        level += (heard-level)*(1-pow(1-(heard>level ? 0.5 : 0.1),frames))
        if level > 0.04 { whose += ((yours ? 1 : 0)-whose)*(1-pow(0.86,frames)) }
        paint += (want-paint)*min(1,dt*1.6)
        energy += (wantEnergy-energy)*min(1,dt*1.2)
        glow += ((thinking ? 0.7 : 0)-glow)*min(1,dt*2.5)
        swell += (level*(1-whose)-swell)*min(1,dt*6)
        veil += (min(0.7,whose*level*1.1)-veil)*min(1,dt*3)
        let still: Float = reduceMotion ? 0.35 : 1
        drift += dt*(0.03+swell*0.1+energy*0.025+glow*0.03)*still
        churn += dt*(0.22+swell*0.8+energy*0.2+(thinking ? 0.75 : 0))*still
        render(t: Float(elapsed), still: still)
    }
    private func render(t: Float, still: Float) {
        let scale = 1+(0.012*sin(t*1.05)+swell*0.03)*still
        let values: [String: Float] = ["uLine":0.2+sin(t*0.37)*0.025*still,"uDrift":drift,"uChurn":churn,"uSwell":swell,"uVeil":veil,"uGlow":glow,"uDim":0,"uScale":scale,"uPx":2/(Float(size.width)*0.78*scale),"uHasFinger":0]
        for (name,value) in values { uniforms[name]?.floatValue = value }
        uniforms["uSkyTop"]?.vectorFloat3Value = paint/255
        uniforms["uSkyHorizon"]?.vectorFloat3Value = (paint+(SIMD3<Float>(repeating:255)-paint)*0.58)/255
        uniforms["uCloud"]?.vectorFloat3Value = SIMD3<Float>(255,249,240)/255
        uniforms["uPaper"]?.vectorFloat3Value = SIMD3<Float>(repeating:0)
    }
}
