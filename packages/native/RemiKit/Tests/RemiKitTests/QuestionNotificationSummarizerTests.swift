import Foundation
import Testing
@testable import RemiKit

struct QuestionNotificationSummarizerTests {
    @Test func shortQuestionUsesImmediateNormalizedFallback() async {
        let summarizer = QuestionNotificationSummarizer(deadline: .seconds(1)) { _ in
            Issue.record("Short questions should not invoke the model")
            return "unused"
        }

        let summary = await summarizer.summary(
            questionID: "short",
            text: "  Allow   Bash to run tests?\n"
        )

        #expect(summary == "Allow Bash to run tests?")
    }

    @Test func generatedSummaryIsCachedByQuestionID() async {
        let calls = Counter()
        let summarizer = QuestionNotificationSummarizer(deadline: .seconds(1)) { _ in
            await calls.increment()
            return "Run the release build on the selected machine?"
        }
        let longQuestion = String(repeating: "Please review this permission request carefully. ", count: 4)

        let first = await summarizer.summary(questionID: "cached", text: longQuestion)
        let second = await summarizer.summary(questionID: "cached", text: "Different text")

        #expect(first == "Run the release build on the selected machine?")
        #expect(second == first)
        #expect(await calls.value == 1)
    }

    @Test func timeoutFallsBackWithoutWaitingForGeneration() async {
        let summarizer = QuestionNotificationSummarizer(deadline: .milliseconds(20)) { _ in
            try await Task.sleep(for: .seconds(2))
            return "Too late"
        }
        let input = String(repeating: "A long question that needs a concise notification. ", count: 4)

        let clock = ContinuousClock()
        let started = clock.now
        let summary = await summarizer.summary(questionID: "timeout", text: input)

        #expect(summary == QuestionNotificationSummarizer.fallback(for: input))
        #expect(started.duration(to: clock.now) < .seconds(1))
    }

    @Test func invalidGeneratedTextFallsBack() async {
        let summarizer = QuestionNotificationSummarizer(deadline: .seconds(1)) { _ in
            String(repeating: "invented ", count: 30)
        }
        let input = String(repeating: "Original permission context. ", count: 6)

        let summary = await summarizer.summary(questionID: "invalid", text: input)

        #expect(summary == QuestionNotificationSummarizer.fallback(for: input))
    }

    @Test func emptyQuestionStillProducesMeaningfulNotificationCopy() {
        #expect(QuestionNotificationSummarizer.fallback(for: " \n ") == "Agent needs your attention.")
    }
}

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}
