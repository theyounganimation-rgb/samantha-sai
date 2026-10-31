import SwiftUI

@main
struct SAIWatchApp: App {
    @StateObject private var store = WatchStore()
    @StateObject private var call = WatchVoiceCall()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            Group {
                if call.active { WatchCallView(call: call, mood: store.mood) }
                else {
                    NavigationStack {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                Button { call.start(home: store.home, cookie: store.cookie) } label: {
                                    Label("Call Samantha", systemImage: "phone.fill").frame(maxWidth: .infinity)
                                }.tint(Color(red: 0.81, green: 0.38, blue: 0.26)).disabled(!store.paired)
                                if let error = call.error { Text(error).font(.footnote).foregroundStyle(.orange) }
                                if !store.notice.isEmpty { Text(store.notice).font(.footnote).foregroundStyle(.secondary) }
                                if let updated = store.updatedAt {
                                    Text("Synced \(updated, style: .relative) ago").font(.caption2).foregroundStyle(.secondary)
                                }
                                if store.messages.isEmpty { Text(store.paired ? "No messages yet." : "Your conversation will appear here.").foregroundStyle(.secondary) }
                                ForEach(store.messages.reversed()) { message in
                                    NavigationLink {
                                        WatchMessageDetail(message: message, store: store)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 5) {
                                            HStack {
                                                Text(message.role == "assistant" ? "Samantha" : "You").font(.caption).foregroundStyle(message.role == "assistant" ? .orange : .secondary)
                                                Spacer()
                                                MessageTime(value: message.timestamp)
                                            }
                                            Text(message.text).font(.body).lineLimit(nil).fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.leading)
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                    }.buttonStyle(.plain).padding(10)
                                        .background(message.role == "assistant" ? Color.orange.opacity(0.10) : Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
                                }
                                Button("Refresh") { Task { @MainActor in await store.refresh() } }
                            }.padding(.horizontal, 4)
                        }.navigationTitle("Samantha")
                    }
                }
            }
            .task {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--watch-network-probe") {
                    // Real device connection test: no microphone transmission or proactive replies.
                    for _ in 0..<30 {
                        if store.paired { call.start(home: store.home, cookie: store.cookie, networkProbe: true); break }
                        try? await Task.sleep(for: .seconds(1))
                    }
                    return
                }
                if ProcessInfo.processInfo.arguments.contains("--watch-call-preview") {
                    call.active = true; call.state = "listening"
                    return
                }
                if ProcessInfo.processInfo.arguments.contains("--watch-messages-preview") {
                    store.messages = [WatchMessage(id:"preview-1", role:"assistant", text:"hey, how are you feeling?", timestamp:"2026-10-28T19:00:00Z"), WatchMessage(id:"preview-2", role:"user", text:"Made it home. Give me a minute?", timestamp:"2026-10-28T19:01:00Z"), WatchMessage(id:"preview-3", role:"assistant", text:"yeah, take your time 🤍", timestamp:"2026-10-28T19:02:00Z")]
                    store.notice = "Preview · sample conversation"; store.updatedAt = Date()
                    return
                }
                #endif
                while !Task.isCancelled {
                    if phase == .active {
                        if call.active { await store.refreshMood() } else { await store.refresh() }
                    }
                    try? await Task.sleep(for: .seconds(call.active ? 8 : 15))
                }
            }
            .onChange(of: phase) { _, next in if next == .active { call.networkAvailable(); Task { @MainActor in await store.refresh() } } }
        }
    }
}

private struct MessageTime: View {
    let value: String
    var body: some View {
        if let date = ISO8601DateFormatter().date(from: value) ?? Self.fractional.date(from: value) {
            Text(date, style: .time).font(.caption2).foregroundStyle(.secondary)
        }
    }
    static let fractional: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}

private struct WatchCallView: View {
    @ObservedObject var call: WatchVoiceCall
    let mood: [String: Any]
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                WatchOrb(call: call, mood: mood)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .offset(y: -24)
                    .accessibilityLabel("Samantha’s voice and mood")
                    .onTapGesture { call.interrupt() }
                VStack(spacing: 5) {
                Text(call.networkProbe ? "Connection test · mic off" : call.state.capitalized).font(.caption2).foregroundStyle(.white.opacity(0.9)).lineLimit(1)
                    .padding(.horizontal, 8).padding(.vertical, 2).background(.black.opacity(0.65), in: Capsule())
                HStack(spacing: 26) {
                    Button { call.toggleMute() } label: {
                        Image(systemName: call.muted ? "mic.slash.fill" : "mic.fill")
                            .frame(width: 48, height: 40).background(call.muted ? Color.orange : Color.white.opacity(0.18), in: Capsule())
                    }.accessibilityLabel(call.muted ? "Unmute microphone" : "Mute microphone")
                    Button { call.end() } label: {
                        Image(systemName: "phone.down.fill").frame(width: 58, height: 40).background(.red, in: Capsule())
                    }.accessibilityLabel("End call")
                }.buttonStyle(.plain)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height)
        }.background(.black).toolbar(.hidden, for: .navigationBar)
    }
}


struct WatchMessageDetail: View {
    let message: WatchMessage
    @ObservedObject var store: WatchStore
    @State private var fullText: String?
    @State private var failed = false
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 10) {
            Text(message.role == "assistant" ? "Samantha" : "You").font(.headline).foregroundStyle(.orange)
            MessageTime(value: message.timestamp)
            Text(fullText ?? message.text).font(.body).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
            if message.needsFullText == true && fullText == nil {
                if failed { Text("Couldn't load the complete message. Reconnect and try again.").font(.footnote)
                    Button("Retry") { Task { await load() } }
                } else { ProgressView() }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4) }.task { await load() }
    }
    private func load() async { failed = false; fullText = await store.fullText(for: message); failed = fullText == nil }
}
