import Testing
@testable import RemiUI

@Suite struct RemiBoardTileSendStateTests {
    @Test func sendRuleUsesLiteralLiveDraftAndInFlightCases() {
        let rows: [(draft: String, isLive: Bool, state: RemiBoardTileSendState, expected: Bool)] = [
            ("typed", true, RemiBoardTileSendState(isSending: true), false),
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
}
