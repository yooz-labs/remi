# iPhone local notification ordering source control (#1720)

This opt-in fixture exercises the real iPhone `PhoneLiveRootView` observation, `MachineStore.receive` question/resolution transitions and `PhoneNotificationCoordinator.notify`. Only OS notification authorization/add/remove, an in-process synthetic Store binding and a controlled wait at the OS-add boundary are substituted. The isolated simulator has a separate bundle and starts no owner hub or notification service. It does not demonstrate OS-delivered notifications, APNs, authenticated transport, or physical-device behavior.

The pre-fix source produced `remove(Q)` followed by a held `add(Q)` after the Store received a resolution. A second control produced an older add after a newer same-ID incarnation. The test-only boundary can also delay removal independently of add: an old removal must not erase a newer request. The assertions check the final recorded OS state after the actual notification task settles, so the same tests can pass when a fix removes a stale in-flight request. Active, add-then-remove, two distinct questions and initial-census controls also run. The original first failure and instrumentation differences are preserved in the issue's local handoff.

Prepare only inside an existing, empty, private directory that belongs to the current user:

```sh
python3 packages/native/Tests/LocalNotificationOrdering/prepare.py /absolute/path/to/owned-empty-directory
cd /absolute/path/to/owned-empty-directory
xcodegen generate --spec project.yml
```

Review `instrumentation-diffs.json` and `source-hashes.json`, create a new dedicated compatible iOS simulator, and use Xcode's `build-for-testing` and `test-without-building` with that exact simulator and derived-data path. Do not reuse or modify a user simulator. Shut down only the dedicated test simulator after use, preserve the first failing results and do not grant notification permission: the simulated OS boundary records test-only operations. Source-anchor mismatches are hard failures requiring review, not a reason to silently change the test.
