import AVFoundation
import Combine
import ElevenLabs
import Foundation
import UIKit

/// Owner, October 27, 2026: Samantha's voice on a call is an ElevenLabs realtime agent in her own voice. The Mac (SAI) still owns
/// the call: it builds her prompt from her live state, mints the conversation token, keeps the agent aware through contextual
/// updates and answers its tools from her backend. This bridge holds the agent connection on the phone (WebRTC, ElevenLabs
/// Swift SDK), relays transcripts, states and tool calls to the Mac over the existing call socket, and feeds the orb.
/// The SDK's Conversation is main-actor isolated, so this bridge is too; NativeVoiceCall (main-queue confined) steps in with assumeIsolated.
@MainActor
final class ElevenAgentBridge {
    /// Control messages for the Mac (sent through the call socket with delivery receipts).
    var relay: (([String: Any]) -> Void)?
    /// Events for the page: state, levels, mute.
    var emit: (([String: Any]) -> Void)?
    private(set) var active = false
    private var conversation: Conversation?
    private var cancellables = Set<AnyCancellable>()
    private var relayedToolCalls = Set<String>()
    private var levelTimer: Timer?
    private var speaking = false
    private var generation = UUID()

    func start(_ payload: [String: Any]) {
        guard !active else { return }
        guard let token = payload["token"] as? String, !token.isEmpty else { relay?(["type": "eleven_failed", "error": "The Mac sent no conversation token."]); return }
        active = true; generation = UUID(); let token_ = generation
        let tts = payload["tts"] as? [String: Any]
        var dynamic: [String: String] = [:]
        for (key, value) in (payload["dynamicVariables"] as? [String: Any]) ?? [:] { dynamic[key] = "\(value)" }
        let config = ConversationConfig(
            agentOverrides: AgentOverrides(prompt: payload["prompt"] as? String, firstMessage: payload["firstMessage"] as? String, language: nil),
            ttsOverrides: TTSOverrides(voiceId: nil, stability: tts?["stability"] as? Double, speed: tts?["speed"] as? Double, similarityBoost: tts?["similarityBoost"] as? Double),
            conversationOverrides: ConversationOverrides(textOnly: false),
            dynamicVariables: dynamic.isEmpty ? nil : dynamic,
            onAgentReady: { [weak self] in Task { @MainActor in self?.agentReady(token_) } },
            onDisconnect: { [weak self] reason in Task { @MainActor in self?.disconnected(reason, token: token_) } },
            onStartupStateChange: { [weak self] state in Task { @MainActor in self?.startupState(state, token: token_) } },
            networkConfiguration: LiveKitNetworkConfiguration(strategy: (payload["network"] as? String) == "relayOnly" ? .relayOnly : .automatic),
            onError: { [weak self] error in Task { @MainActor in self?.failed(String(describing: error), token: token_) } },
            onAgentResponse: { [weak self] text, eventId in Task { @MainActor in self?.forward(["type": "agent_response", "text": text, "eventId": eventId]) } },
            onAgentResponseCorrection: { [weak self] original, corrected, eventId in Task { @MainActor in self?.forward(["type": "agent_response_correction", "original": original, "corrected": corrected, "eventId": eventId]) } },
            onUserTranscript: { [weak self] text, eventId in Task { @MainActor in self?.forward(["type": "user_transcript", "text": text, "eventId": eventId]) } },
            onConversationMetadata: { [weak self] meta in Task { @MainActor in self?.forward(["type": "eleven_metadata", "conversationId": meta.conversationId, "agentAudio": meta.agentOutputAudioFormat, "userAudio": meta.userInputAudioFormat]) } },
            onInterruption: { [weak self] eventId in Task { @MainActor in self?.forward(["type": "interruption", "eventId": eventId]) } },
            onVadScore: { [weak self] score in Task { @MainActor in self?.userLevel(score) } },
            onAgentStateChange: { [weak self] state in Task { @MainActor in self?.agentState(state) } }
        )
        Task { [weak self] in
            do {
                let conversation = try await ElevenLabs.startConversation(conversationToken: token, config: config)
                await MainActor.run { self?.attach(conversation, token: token_) }
            } catch {
                await MainActor.run { self?.failed(String(describing: error), token: token_) }
            }
        }
    }
    private func attach(_ conversation: Conversation, token: UUID) {
        guard active, generation == token else { Task { await conversation.endConversation() }; return }
        self.conversation = conversation
        conversation.$pendingToolCalls.receive(on: DispatchQueue.main).sink { [weak self] calls in
            guard let self else { return }
            for call in calls where !self.relayedToolCalls.contains(call.toolCallId) {
                self.relayedToolCalls.insert(call.toolCallId)
                let parameters = (try? call.getParameters()) ?? [:]
                self.forward(["type": "tool_call", "toolCallId": call.toolCallId, "toolName": call.toolName, "parameters": parameters, "expectsResponse": call.expectsResponse])
                if !call.expectsResponse { conversation.markToolCallCompleted(call.toolCallId) }
            }
        }.store(in: &cancellables)
        conversation.$isMuted.receive(on: DispatchQueue.main).sink { [weak self] muted in self?.emit?(["type": "native_mute", "muted": muted]) }.store(in: &cancellables)
        conversation.$state.receive(on: DispatchQueue.main).sink { [weak self] state in
            guard let self, self.active else { return }
            if case .error(let error) = state { self.failed(error.localizedDescription, token: token) }
            else if case .ended(let reason) = state { self.disconnected(reason == .userEnded ? .user : .agent, token: token) }
        }.store(in: &cancellables)
    }
    /// The SDK's separate agent-ready callback did not fire on the first real call (October 27); the startup state reaching
    /// active is the reliable signal, so readiness is reported from it as well. The Mac treats the first signal as the one.
    private func startupState(_ state: ConversationStartupState, token: UUID) {
        guard active, generation == token else { return }
        forward(["type": "eleven_startup", "state": String(describing: state).prefix(120).description])
        if case .active(_, let metrics) = state {
            forward(["type": "eleven_startup_metrics", "total": metrics.total ?? -1, "tokenFetch": metrics.tokenFetch ?? -1, "roomConnect": metrics.roomConnect ?? -1, "agentReady": metrics.agentReady ?? -1, "agentReadyBuffer": metrics.agentReadyBuffer ?? -1, "conversationInit": metrics.conversationInit ?? -1, "initAttempts": metrics.conversationInitAttempts])
            playReadyTone(); agentReady(token)
        }
    }
    /// The classic call played a short application tone when the line was ready; here the agent's audio runs through LiveKit, so a
    /// 240 ms tone is synthesised and played with AVAudioPlayer on the same session. It is never Samantha's speech.
    private var readyTonePlayer: AVAudioPlayer?
    private func playReadyTone() {
        let rate = 24000, count = Int(Double(rate) * 0.24)
        var pcm = Data(count: count * 2)
        pcm.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            for i in 0..<count {
                let t = Double(i) / Double(rate)
                let envelope = min(1, t / 0.008, max(0, (0.24 - t) / 0.025)) * exp(-t / 0.085)
                let value = envelope * (0.035 * sin(2 * .pi * 880 * t) + 0.012 * sin(2 * .pi * 1320 * t))
                raw.storeBytes(of: Int16(max(-32767, min(32767, value * 32767))).littleEndian, toByteOffset: i * 2, as: Int16.self)
            }
        }
        var wav = Data()
        func le32(_ v: UInt32) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 4)) }
        func le16(_ v: UInt16) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 2)) }
        wav.append("RIFF".data(using: .ascii)!); le32(UInt32(36 + pcm.count)); wav.append("WAVEfmt ".data(using: .ascii)!); le32(16); le16(1); le16(1); le32(UInt32(rate)); le32(UInt32(rate * 2)); le16(2); le16(16); wav.append("data".data(using: .ascii)!); le32(UInt32(pcm.count)); wav.append(pcm)
        readyTonePlayer = try? AVAudioPlayer(data: wav); readyTonePlayer?.volume = 0.9; readyTonePlayer?.play()
    }
    private func agentReady(_ token: UUID) {
        guard active, generation == token else { return }
        forward(["type": "eleven_ready", "conversationId": conversation?.conversationMetadata?.conversationId ?? ""])
    }
    private func agentState(_ state: ElevenLabs.AgentState) {
        guard active else { return }
        let name: String
        switch state { case .speaking: name = "speaking"; case .thinking: name = "thinking"; default: name = "listening" }
        speaking = state == .speaking
        forward(["type": "agent_state", "state": name])
        if speaking, levelTimer == nil {
            // The agent's audio plays through LiveKit, outside our meter. A lively synthetic level keeps the orb moving while she speaks.
            levelTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.speaking else { self?.levelTimer?.invalidate(); self?.levelTimer = nil; return }
                    self.emit?(["type": "native_level", "speaker": "assistant", "level": 0.18 + Double.random(in: 0...0.22)])
                }
            }
        }
    }
    private func userLevel(_ score: Double) {
        guard active, UIApplication.shared.applicationState == .active else { return }
        emit?(["type": "native_level", "speaker": "user", "level": min(1, max(0, score)) * 0.6])
    }
    private func forward(_ item: [String: Any]) { guard active else { return }; relay?(item) }
    private func failed(_ message: String, token: UUID) {
        guard active, generation == token else { return }
        forward(["type": "eleven_failed", "error": String(message.prefix(300))]); teardown()
    }
    private func disconnected(_ reason: DisconnectionReason, token: UUID) {
        guard active, generation == token else { return }
        let name: String
        switch reason { case .user: name = "user-ended"; case .agent: name = "agent-ended"; case .error: name = "connection-error" }
        forward(["type": "conversation_ended", "reason": name]); teardown()
    }
    /// From the Mac: background information the agent should know without being interrupted.
    func updateContext(_ text: String) { guard let conversation else { return }; Task { try? await conversation.updateContext(text) } }
    /// From the Mac: the answer to a client tool call.
    func toolResult(id: String, result: String, isError: Bool) {
        guard let conversation else { return }
        Task { do { try await conversation.sendToolResult(for: id, result: result, isError: isError) } catch { await MainActor.run { self.forward(["type": "tool_result_failed", "toolCallId": id, "error": error.localizedDescription]) } } }
    }
    func setMuted(_ value: Bool) { guard let conversation else { return }; Task { try? await conversation.setMuted(value) } }
    /// The SDK's interrupt resets the agent's turn timer; a spoken word from the caller is what actually stops her mid-sentence.
    func interrupt() { guard let conversation else { return }; Task { try? await conversation.interruptAgent() } }
    func end() {
        guard active else { return }
        let conversation = self.conversation; teardown()
        Task { await conversation?.endConversation() }
    }
    private func teardown() {
        active = false; speaking = false; levelTimer?.invalidate(); levelTimer = nil
        cancellables.removeAll(); relayedToolCalls.removeAll(); conversation = nil
    }
}
