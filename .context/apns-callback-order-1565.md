# APNs callback ordering regression (#1565)

Release PR #1564 failed the unchanged duplicate-callback refusal assertion in the
legacy Mac gate. Both Swift copies dispatch callbacks as independent MainActor
tasks. The suspected mechanism is task execution reordering, so an earlier
duplicate is ignored after a later complementary result finishes the attempt.

1. Add a repeated regression against the actual native resolver and keep the
   original legacy assertion unchanged. Capture failure before modifying logic.
2. If reproduced, preserve callback arrival order at the actor hop in both
   copies. Keep exact entitlement decisions, deadline, context and cancellation.
3. Run the regression and original legacy test, then native Swift, Mac and
   iPhone gates. No test removal, exception or repeated CI rerun as a fix.
4. Review a fix PR into develop. A changed native push source requires the next
   signed candidate build 13; retain the immutable uploaded build 12.
5. Refresh the final CLI integration review only for the added fix commits and
   require fresh final-head CI before main publication.

The injected boundary controls only callback delivery; aggregation is the real
production object. This does not establish duplicate callbacks from Apple, nor
signed-device APNs acceptance. The external query already enforces one reply.

The original Xcode 15.4/macOS 14 runner reproduced 22 accepted attempts out of 1,000
at the test-only checkpoint c29dc252 (run 39398018055). Xcode 27 local native and
legacy controls accepted 0/1,000. The original one-attempt assertion remained
unchanged and happened to pass during the repeated-regression failure.

The outcome proves an earlier duplicate was handled after the complementary
result had already finished the attempt. Swift actors do not promise FIFO
execution ([SE-0306](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0306-actors.md));
the main DispatchQueue preserves submission order. The source fix replaces only
that callback hop in both implementations, retaining generation/context checks
and lease disposal. No query or runtime entitlement fallback is added.

Local source checks after the fix passed 249 Swift tests in 44 suites, including
the real owned source hub and Worker relay controls on Bun 1.3.11; the native Mac
build/test and iPhone simulator build passed. The legacy 14 environment tests,
unchanged original refusal case, both native positive environments, three
version-sync tests, Biome and the native TestFlight preflight also passed.
The final old-runtime hosted regression and independent review remain required.
