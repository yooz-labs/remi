import Testing
@testable import RemiUI

@Suite struct RemiBoardTileSendStateTests {
    @Test func sendRuleUsesLiteralLiveDraftAndInFlightCases() {
        let rows: [(draft: String, isLive: Bool, state: RemiBoardTileSendState, expected: Bool)] = [
            ("typed", true, RemiBoardTileSendState(isSending: true), false),
            ("typed", true, RemiBoardTileSendState(isSending: true, sendFailed: true), false),
            ("typed", true, RemiBoardTileSendState(sendFailed: true), true),
            (" \t\n", true, RemiBoardTileSendState(), false),
            ("", true, RemiBoardTileSendState(), false),
            ("typed", false, RemiBoardTileSendState(), false),
            (" typed ", true, RemiBoardTileSendState(), true),
        ]

        for row in rows {
            #expect(
                RemiBoardTileStateRules.canSend(draft: row.draft, isLive: row.isLive, state: row.state)
                    == row.expected
            )
        }
    }

    @Test func layoutChangeKeepsOnlyAComposerThatStillExists() {
        let rows: [(focusedKey: String?, composerKeys: Set<String>, expected: String?)] = [
            ("card-a", ["card-a", "card-b"], "card-a"),
            ("card-a", ["card-b"], nil),
            ("card-a", [], nil),
            (nil, ["card-a"], nil),
        ]

        for row in rows {
            #expect(
                RemiBoardTileStateRules.focusAfterLayoutChange(
                    focusedKey: row.focusedKey,
                    composerKeys: row.composerKeys
                ) == row.expected
            )
        }
    }

    @Test func externalStateWinsAndNilKeepsTheTileFallback() {
        let internalState = RemiBoardTileSendState(isSending: true)
        let externalState = RemiBoardTileSendState(sendFailed: true)

        #expect(
            RemiBoardTileStateRules.selectedSendState(external: externalState, fallback: internalState)
                == externalState
        )
        #expect(
            RemiBoardTileStateRules.selectedSendState(external: nil, fallback: internalState)
                == internalState
        )
    }

    @Test func storingSendStateHandlesInFlightFailureAndIdleTransitions() {
        let sending = RemiBoardTileSendState(isSending: true)
        let retryingAfterFailure = RemiBoardTileSendState(isSending: true, sendFailed: true)
        let failed = RemiBoardTileSendState(sendFailed: true)
        let idle = RemiBoardTileSendState()
        let unrelated = RemiBoardTileSendState(sendFailed: true)
        let rows: [(key: String, state: RemiBoardTileSendState, states: [String: RemiBoardTileSendState], expected: [String: RemiBoardTileSendState])] = [
            ("new", sending, [:], ["new": sending]),
            (
                "retry",
                retryingAfterFailure,
                ["retry": failed],
                ["retry": retryingAfterFailure]
            ),
            ("live", failed, ["live": sending], ["live": failed]),
            ("gone", failed, ["other": unrelated], ["other": unrelated]),
            ("done", idle, ["done": sending], [:]),
            ("absent", idle, ["other": unrelated], ["other": unrelated]),
            (
                "both",
                retryingAfterFailure,
                [:],
                ["both": retryingAfterFailure]
            ),
        ]

        for row in rows {
            #expect(
                RemiBoardTileStateRules.storing(row.state, forKey: row.key, in: row.states) == row.expected
            )
        }
    }
}
