import Foundation

/// Client introduction sent immediately after the WebSocket opens.
public struct HelloMessage: Codable, Sendable, Equatable {
    public let type = "hello"
    public let id: String
    public let timestamp: String
    public let clientVersion: String
    public let clientId: String
    public let directory: String?
    public let resumeSessionId: String?
    public let lastReceivedIndex: Int?
    public let mode: String?
    public let deviceId: String?

    public init(
        id: String,
        timestamp: String,
        clientVersion: String,
        clientId: String,
        directory: String? = nil,
        resumeSessionId: String? = nil,
        lastReceivedIndex: Int? = nil,
        mode: String? = nil,
        deviceId: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.directory = directory
        self.resumeSessionId = resumeSessionId
        self.lastReceivedIndex = lastReceivedIndex
        self.mode = mode
        self.deviceId = deviceId
    }
}

/// Daemon introduction. Optional fields preserve compatibility with older daemons.
public struct HelloAckMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let serverVersion: String
    public let protocolVersion: Int?
    public let capabilities: [String]?
    public let sessionId: String?
    public let claudeSessionId: String?
    public let harness: String?
    public let harnessSessionId: String?
    public let harnesses: [String]?
    public let transcriptPath: String?
    public let isResume: Bool?
    public let replayCount: Int?
    public let nextBulletId: Int?
    public let attachState: String?
    public let daemonVersion: String?
}

public struct AuthChallengeMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let challenge: String
    public let serverFingerprint: String
    public let serverPublicKey: String
    public let relayEphemeralKey: String?
    public let relayKexSignature: String?
    public let answerEncryptionKey: String?
}

public struct AuthResponseMessage: Codable, Sendable, Equatable {
    public let type = "auth_response"
    public let id: String
    public let timestamp: String
    public let clientPublicKey: String
    public let signature: String
    public let clientFingerprint: String
    public let relayEphemeralKey: String?
    public let relayKexSignature: String?

    public init(
        id: String,
        timestamp: String,
        clientPublicKey: String,
        signature: String,
        clientFingerprint: String,
        relayEphemeralKey: String? = nil,
        relayKexSignature: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.clientPublicKey = clientPublicKey
        self.signature = signature
        self.clientFingerprint = clientFingerprint
        self.relayEphemeralKey = relayEphemeralKey
        self.relayKexSignature = relayKexSignature
    }
}

public struct AuthResultMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let success: Bool
    public let error: String?
    public let serverSignature: String?
}

public struct AnswerSelection: Codable, Sendable, Equatable {
    public let questionIndex: Int
    public let optionIndices: [Int]
    public let text: String?

    public init(questionIndex: Int, optionIndices: [Int], text: String? = nil) {
        self.questionIndex = questionIndex
        self.optionIndices = optionIndices
        self.text = text
    }
}

public struct AnswerMessage: Codable, Sendable, Equatable {
    public let type = "answer"
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let questionId: String
    public let answer: String
    public let claudeSessionId: String?
    public let selections: [AnswerSelection]?
    public let cancel: Bool?
    public let message: String?

    public init(
        id: String,
        timestamp: String,
        sessionId: String,
        questionId: String,
        answer: String,
        claudeSessionId: String? = nil,
        selections: [AnswerSelection]? = nil,
        cancel: Bool? = nil,
        message: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.sessionId = sessionId
        self.questionId = questionId
        self.answer = answer
        self.claudeSessionId = claudeSessionId
        self.selections = selections
        self.cancel = cancel
        self.message = message
    }
}

public struct QuestionResolvedMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let questionId: String
    public let reason: String
}

public struct QuestionSnapshotMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let questionIds: [String]
}

public struct TranscriptUsage: Codable, Sendable, Equatable {
    public let inputTokens: Int?
    public let outputTokens: Int?

    enum CodingKeys: String, CodingKey {
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
    }
}

public struct TranscriptContentBlock: Codable, Sendable, Equatable {
    public let type: String
    public let text: String?
    public let toolUseId: String?
    public let toolName: String?
    public let toolInput: String?
    public let toolOutput: String?
    public let isError: Bool?
}

public struct StructuredBullet: Codable, Sendable, Equatable {
    public let bulletId: Int
    public let content: String
    public let type: String
    public let originalNumber: String?
    public let startLine: Int
    public let endLine: Int
    public let hasCodeBlock: Bool
    public let isTruncated: Bool?
    public let fullLength: Int?
}

public struct StructuredMessage: Codable, Sendable, Equatable {
    public let id: String
    public let sessionId: String
    public let sender: String
    public let content: String
    public let createdAt: String
    public let state: String
    public let stateChangedAt: String
    public let editedAt: String?
    public let isEditing: Bool
    public let tool: String?
    public let bullets: [StructuredBullet]
    public let firstBulletId: Int?
    public let lastBulletId: Int?
}

public struct TranscriptContentMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let entryUuid: String
    public let role: String
    public let content: String
    public let tools: [String]?
    public let model: String?
    public let hadThinking: Bool?
    public let usage: TranscriptUsage?
    public let message: StructuredMessage
    public let isUpdate: Bool
    public let contentBlocks: [TranscriptContentBlock]?
}

public struct TranscriptLoadRequestMessage: Codable, Sendable, Equatable {
    public let type = "transcript_load_request"
    public let id: String
    public let timestamp: String
    public let sessionId: String

    public init(id: String, timestamp: String, sessionId: String) {
        self.id = id
        self.timestamp = timestamp
        self.sessionId = sessionId
    }
}

public struct TranscriptLoadCompleteMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let messageCount: Int
    public let requestId: String
}

public struct SessionViewMeta: Decodable, Sendable, Equatable, Identifiable {
    public var id: String { agentId }
    public let agentId: String
    public let agentType: String
    public let active: Bool

    public init(agentId: String, agentType: String, active: Bool) {
        self.agentId = agentId
        self.agentType = agentType
        self.active = active
    }
}

public struct SessionViewsMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let subagents: [SessionViewMeta]
}

public struct SessionListRequestMessage: Codable, Sendable, Equatable {
    public let type = "session_list_request"
    public let id: String
    public let timestamp: String
    public let includeExternal: Bool?

    public init(id: String, timestamp: String, includeExternal: Bool? = nil) {
        self.id = id
        self.timestamp = timestamp
        self.includeExternal = includeExternal
    }
}

public struct CreateSessionRequestMessage: Codable, Sendable, Equatable {
    public let type = "create_session_request"
    public let id: String
    public let timestamp: String
    public let directory: String?
    public let harness: String?
    public let args: [String]?
    public let workspace: WorkspaceRequest?

    public init(
        id: String,
        timestamp: String,
        directory: String? = nil,
        harness: String? = nil,
        args: [String]? = nil,
        workspace: WorkspaceRequest? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.directory = directory
        self.harness = harness
        self.args = args
        self.workspace = workspace
    }
}

public struct WorkspaceRequest: Codable, Sendable, Equatable {
    public let repository: String
    public let worktree: WorktreeRequest?

    public init(repository: String, worktree: WorktreeRequest? = nil) {
        self.repository = repository
        self.worktree = worktree
    }
}

public struct WorktreeRequest: Codable, Sendable, Equatable {
    public let branch: String
    public let base: String?

    public init(branch: String, base: String? = nil) {
        self.branch = branch
        self.base = base
    }
}

public struct RecentRepositoriesRequestMessage: Codable, Sendable, Equatable {
    public let type = "recent_repositories_request"
    public let id: String
    public let timestamp: String
    public let limit: Int?

    public init(id: String, timestamp: String, limit: Int? = nil) {
        self.id = id
        self.timestamp = timestamp
        self.limit = limit
    }
}

public struct RecentRepository: Decodable, Sendable, Equatable, Identifiable {
    public var id: String { repository }
    public let repository: String
    public let name: String
    public let lastUsedAt: String
}

public struct RecentRepositoriesResponseMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let requestId: String
    public let repositories: [RecentRepository]
}

public struct CreateSessionResponseMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let success: Bool
    public let requestId: String
    public let sessionId: String?
    public let port: Int?
    public let error: String?
    public let errorCode: String?
    public let notice: String?
}

public struct KillSessionRequestMessage: Codable, Sendable, Equatable {
    public let type = "kill_session_request"
    public let id: String
    public let timestamp: String
    public let sessionId: String

    public init(id: String, timestamp: String, sessionId: String) {
        self.id = id
        self.timestamp = timestamp
        self.sessionId = sessionId
    }
}

public struct KillSessionResponseMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let success: Bool
    public let error: String?
    public let requestId: String
}

public struct UserInputMessage: Codable, Sendable, Equatable {
    public let type = "user_input"
    public let id: String
    public let timestamp: String
    public let sessionId: String
    public let content: String
    public let raw: Bool?
    public let claudeSessionId: String?

    public init(
        id: String,
        timestamp: String,
        sessionId: String,
        content: String,
        raw: Bool? = nil,
        claudeSessionId: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.sessionId = sessionId
        self.content = content
        self.raw = raw
        self.claudeSessionId = claudeSessionId
    }
}

public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else if let decoded = try? value.decode([String: JSONValue].self) { self = .object(decoded) }
        else { self = .array(try value.decode([JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .null: try value.encodeNil()
        }
    }
}

public struct ErrorMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let code: String
    public let message: String
    public let details: [String: JSONValue]?
}

public struct SessionWireState: Decodable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let startedAt: String
    public let status: String
    public let isActive: Bool
}

public struct SessionUpdateMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let session: SessionWireState
}
