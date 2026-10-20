# APNs callback ordering regression (#1565)

Release PR1564 failed the unchanged duplicate-callback refusal assertion in the
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
   signed candidate build13; retain the immutable uploaded build12.
5. Refresh the final CLI integration review only for the added fix commits and
   require fresh final-head CI before main publication.

The injected boundary controls only callback delivery; aggregation is the real
production object. This does not establish duplicate callbacks from Apple, nor
signed-device APNs acceptance. The external query already enforces one reply.
