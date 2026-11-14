/// An ordered transcript with O(1) UUID lookup and amortized O(1) replacement.
///
/// Replacing an existing entry unlinks it and appends its replacement, preserving
/// the order that MachineStore has historically exposed. Removed node slots are
/// compacted occasionally, so duplicate updates do not scan the transcript.
public final class RemiOrderedTranscript: Sequence {
    public typealias Element = TranscriptContentMessage

    private struct Node {
        var message: Element?
        var previous: Int?
        var next: Int?
    }

    public struct Iterator: IteratorProtocol {
        private let transcript: RemiOrderedTranscript
        private var nextNode: Int?

        fileprivate init(transcript: RemiOrderedTranscript, firstNode: Int?) {
            self.transcript = transcript
            nextNode = firstNode
        }

        public mutating func next() -> Element? {
            while let nodeIndex = nextNode {
                let node = transcript.nodes[nodeIndex]
                nextNode = node.next
                guard let message = node.message else { continue }
                transcript.recordElementVisit()
                return message
            }
            return nil
        }
    }

    private var nodes: [Node] = []
    private var nodeByEntryUUID: [String: Int] = [:]
    private var firstNode: Int?
    private var lastNode: Int?
    private var tombstoneCount = 0
    private var liveCount = 0

    /// Counts node visits and moves performed by updates and ordered reads.
    /// Internal so tests can guard work without making timing assertions.
    #if DEBUG
    private(set) var testingElementVisits = 0
    #endif

    private let minimumTombstonesBeforeCompaction = 64

    public init() {}

    public var count: Int { liveCount }

    /// An array snapshot in transcript order for UI and storage readers.
    public var entries: [Element] { Array(self) }

    /// Returns the newest entries in transcript order without traversing older ones.
    public func suffix(_ maxLength: Int) -> [Element] {
        guard maxLength > 0 else { return [] }
        var reversed: [Element] = []
        reversed.reserveCapacity(Swift.min(maxLength, liveCount))
        var nodeIndex = lastNode
        while let index = nodeIndex, reversed.count < maxLength {
            let node = nodes[index]
            nodeIndex = node.previous
            if let message = node.message {
                recordElementVisit()
                reversed.append(message)
            }
        }
        return Array(reversed.reversed())
    }

    public func makeIterator() -> Iterator {
        Iterator(transcript: self, firstNode: firstNode)
    }

    /// Add an entry or replace its UUID and move the replacement to the end.
    func apply(_ message: Element) {
        if let oldNode = nodeByEntryUUID.removeValue(forKey: message.entryUuid) {
            unlink(oldNode)
            nodes[oldNode].message = nil
            nodes[oldNode].previous = nil
            nodes[oldNode].next = nil
            tombstoneCount += 1
            liveCount -= 1
            recordElementVisit()
        }

        append(message)
        compactIfNeeded()
    }

    private func append(_ message: Element) {
        let newNode = nodes.count
        nodes.append(Node(message: message, previous: lastNode, next: nil))
        if let lastNode {
            nodes[lastNode].next = newNode
        } else {
            firstNode = newNode
        }
        lastNode = newNode
        nodeByEntryUUID[message.entryUuid] = newNode
        liveCount += 1
        recordElementVisit()
    }

    private func unlink(_ nodeIndex: Int) {
        let previous = nodes[nodeIndex].previous
        let next = nodes[nodeIndex].next
        if let previous {
            nodes[previous].next = next
        } else {
            firstNode = next
        }
        if let next {
            nodes[next].previous = previous
        } else {
            lastNode = previous
        }
    }

    private func compactIfNeeded() {
        guard tombstoneCount >= minimumTombstonesBeforeCompaction,
              tombstoneCount >= liveCount else { return }

        var compactedNodes: [Node] = []
        compactedNodes.reserveCapacity(liveCount)
        var compactedIndex: [String: Int] = [:]
        compactedIndex.reserveCapacity(liveCount)
        var nodeIndex = firstNode

        while let index = nodeIndex {
            let node = nodes[index]
            nodeIndex = node.next
            guard let message = node.message else { continue }

            let newIndex = compactedNodes.count
            compactedNodes.append(Node(
                message: message,
                previous: newIndex == 0 ? nil : newIndex - 1,
                next: nil
            ))
            if newIndex > 0 { compactedNodes[newIndex - 1].next = newIndex }
            compactedIndex[message.entryUuid] = newIndex
            recordElementVisit()
        }

        nodes = compactedNodes
        nodeByEntryUUID = compactedIndex
        firstNode = nodes.isEmpty ? nil : 0
        lastNode = nodes.indices.last
        tombstoneCount = 0
    }

    private func recordElementVisit() {
        #if DEBUG
        testingElementVisits += 1
        #endif
    }
}
