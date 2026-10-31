import AVFoundation
import CoreImage
import SwiftUI
import UIKit

/// Explicit camera sharing for an existing call. Video never reconfigures call audio.
final class PhoneVision: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let capture = AVCaptureSession()
    var onStatus: (([String: Any]) -> Void)?
    private(set) var enabled = false
    /// October 25 (Owner): which camera is sharing; the selfie camera is a tap away.
    private(set) var position: AVCaptureDevice.Position = .back
    private var foreground = true
    private let queue = DispatchQueue(label: "dev.example.sai.phone-vision")
    private let images = CIContext(options: [.cacheIntermediates: false])
    private var configured = false
    private var lastFrame: CFTimeInterval = 0
    private var sequence = 0
    private var generation = UUID()
    private var outingID: String?
    private var callID: String?
    private var home: URL?
    private var cookie = ""
    private var uploading = false
    /// October 26 (Owner): frames sent to Samantha are turned so the horizon is level (gravity down), whatever way the phone is held.
    /// Before this the connection was fixed at 90 degrees, so a phone held sideways sent her a sideways picture.
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var status = "off"
    private var error: String?
    private let session = URLSession(configuration: .ephemeral)
    func snapshot() -> [String: Any] { ["type":"outing_camera", "enabled":enabled, "cameraStatus":status, "error":error ?? "", "facing": position == .front ? "front" : "back"] }
    private func publish(_ state: String, error: String? = nil) {
        self.status = state; self.error = error
        UIApplication.shared.isIdleTimerDisabled = enabled && foreground
        onStatus?(snapshot())
    }
    private func request(_ route: String, _ body: [String: Any]) async throws -> [String: Any] {
        guard let home else { throw NSError(domain:"SAI",code:1,userInfo:[NSLocalizedDescriptionKey:"Camera connection unavailable."]) }
        var request = URLRequest(url: home.appendingPathComponent("api/outing/" + route))
        request.httpMethod = "POST"; request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField:"Content-Type")
        request.setValue("https://\(home.host!)\(home.port.map { ":\($0)" } ?? "")", forHTTPHeaderField:"Origin")
        request.setValue(cookie, forHTTPHeaderField:"Cookie")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        let value = (try JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NSError(domain:"SAI",code:2,userInfo:[NSLocalizedDescriptionKey:value["error"] as? String ?? "The camera could not connect."])
        }
        return value
    }
    func start(home: URL, cookies: [HTTPCookie], callID: String) {
        guard !enabled else { return }
        self.home = home; self.callID = callID
        self.cookie = HTTPCookie.requestHeaderFields(with:cookies)["Cookie"] ?? ""
        generation = UUID(); let token = generation
        enabled = true; foreground = true; publish("connecting")
        Task { @MainActor [weak self] in
            guard let self else { return }
            let allowed = await AVCaptureDevice.requestAccess(for:.video)
            guard self.enabled, self.generation == token else { return }
            guard allowed else { self.enabled = false; self.publish("off",error:"Allow Camera for SAI in iPhone Settings to share your view."); return }
            do {
                let result = try await self.request("start",["callId":callID])
                guard self.enabled, self.generation == token else { return }
                guard let id = result["id"] as? String else { throw NSError(domain:"SAI",code:3) }
                self.outingID = id; self.publish("waiting")
                if self.foreground { self.queue.async { [weak self] in self?.beginCapture() } }
                else { self.setForeground(false) }
            } catch { self.enabled = false; self.publish("off",error:error.localizedDescription) }
        }
    }
    private func beginCapture() {
        do {
            if !configured {
                capture.beginConfiguration()
                defer { capture.commitConfiguration() }
                for input in capture.inputs { capture.removeInput(input) }
                for output in capture.outputs { capture.removeOutput(output) }
                capture.automaticallyConfiguresApplicationAudioSession = false
                capture.sessionPreset = .vga640x480
                guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,for:.video,position:position) else { throw NSError(domain:"SAI",code:4) }
                let input = try AVCaptureDeviceInput(device:device)
                guard capture.canAddInput(input) else { throw NSError(domain:"SAI",code:5) }
                capture.addInput(input)
                rotation = AVCaptureDevice.RotationCoordinator(device:device,previewLayer:nil)
                let output = AVCaptureVideoDataOutput()
                output.alwaysDiscardsLateVideoFrames = true
                output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]
                output.setSampleBufferDelegate(self,queue:queue)
                guard capture.canAddOutput(output) else { throw NSError(domain:"SAI",code:6) }
                capture.addOutput(output)
                if let connection = output.connection(with:.video), connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
                configured = true
            }
            // begin/commit above ends before starting the capture graph.
            if !capture.isRunning { capture.startRunning() }
        } catch {
            DispatchQueue.main.async { [weak self] in self?.stop(); self?.publish("off",error:"The iPhone camera could not start. Your voice call is still connected.") }
        }
    }
    /// October 25 (Owner): switch between the back camera and the selfie camera while sharing. Audio is never touched.
    func flip() {
        position = position == .back ? .front : .back
        queue.async { [weak self] in self?.reconfigureInput() }
        onStatus?(snapshot())
    }
    private func reconfigureInput() {
        guard configured else { return }
        capture.beginConfiguration()
        defer { capture.commitConfiguration() }
        for input in capture.inputs { capture.removeInput(input) }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,for:.video,position:position),
              let input = try? AVCaptureDeviceInput(device:device), capture.canAddInput(input) else { return }
        capture.addInput(input)
        rotation = AVCaptureDevice.RotationCoordinator(device:device,previewLayer:nil)
        if let connection = capture.outputs.first?.connection(with:.video) {
            if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
            // Frames sent to Samantha are never mirrored; the preview layer mirrors the selfie camera on its own.
            connection.automaticallyAdjustsVideoMirroring = false; connection.isVideoMirrored = false
        }
    }
    func stop(sendControl: Bool = true) {
        guard enabled || outingID != nil else { return }
        let id = outingID, call = callID
        enabled = false; generation = UUID(); outingID = nil; publish("off")
        queue.async { [weak self] in self?.capture.stopRunning() }
        if sendControl, let id, let call { Task { @MainActor [weak self] in _ = try? await self?.request("stop",["id":id,"callId":call]) } }
    }
    func setForeground(_ value: Bool) {
        foreground = value; guard enabled else { return }
        if value { publish("waiting"); queue.async { [weak self] in self?.beginCapture() } }
        else {
            publish("paused"); queue.async { [weak self] in self?.capture.stopRunning() }
            if let id = outingID, let call = callID { Task { @MainActor [weak self] in _ = try? await self?.request("status",["id":id,"callId":call,"status":"paused"]) } }
        }
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = CACurrentMediaTime()
        if let rotation {
            let level = rotation.videoRotationAngleForHorizonLevelCapture
            if connection.videoRotationAngle != level, connection.isVideoRotationAngleSupported(level) { connection.videoRotationAngle = level }
        }
        guard now-lastFrame >= 4, let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrame = now
        let image = CIImage(cvPixelBuffer:pixel)
        guard let cg = images.createCGImage(image,from:image.extent), let jpeg = UIImage(cgImage:cg).jpegData(compressionQuality:0.58), jpeg.count <= 180000 else { return }
        let at = ISO8601DateFormatter().string(from:Date())
        DispatchQueue.main.async { [weak self] in
            guard let self, self.enabled, self.foreground, !self.uploading, let id = self.outingID, let call = self.callID else { return }
            let token = self.generation; self.sequence += 1; let sequence = self.sequence; self.uploading = true
            Task { @MainActor [weak self] in
                guard let self else { return }
                defer { self.uploading = false }
                do {
                    _ = try await self.request("frame",["id":id,"callId":call,"sequence":sequence,"capturedAt":at,"jpeg":jpeg.base64EncodedString()])
                    if self.enabled, self.generation == token, self.foreground { self.publish("on") }
                } catch {
                    if self.enabled, self.generation == token, self.foreground { self.publish("waiting",error:"Camera reconnecting. Your call can continue.") }
                }
            }
        }
    }
}
struct PhoneCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class View: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
    func makeUIView(context: Context) -> View { let view=View();view.preview.session=session;view.preview.videoGravity = .resizeAspectFill;return view }
    func updateUIView(_ uiView: View, context: Context) {}
}
