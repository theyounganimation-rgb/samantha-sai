import Foundation

/// A receipt means all buffers reached the output device, never just that synthesis finished.
struct NativePlaybackLedger {
    struct Ticket { let generation: Int; let id: Int }
    struct Completion { let turn: Int; let success: Bool }
    private var generation = 0
    private var nextID = 0
    private var pending: Set<Int> = []
    private var turn: Int?
    private var finished = false
    private var failed = false
    private var delivered = false
    mutating func enqueue(turn value: Int) -> Ticket? {
        if turn != value { cancel(); turn = value }
        guard !finished && !delivered else { return nil }
        nextID += 1; pending.insert(nextID)
        return Ticket(generation: generation, id: nextID)
    }
    mutating func rendered(ticket: Ticket) {
        guard ticket.generation == generation else { return }
        pending.remove(ticket.id)
    }
    mutating func finish(turn value: Int) { if turn == value { finished = true } }
    mutating func fail(turn value: Int) {
        if turn != value { cancel(); turn = value }
        failed = true; finished = true
    }
    mutating func takeCompletion() -> Completion? {
        guard let turn, finished, pending.isEmpty, !delivered else { return nil }
        delivered = true; return Completion(turn: turn, success: !failed)
    }
    mutating func cancel() {
        generation += 1; pending = []; turn = nil; finished = false; failed = false; delivered = false
    }
}
