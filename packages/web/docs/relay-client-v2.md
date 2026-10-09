# Relay v2 client (#1199)

Choose **Connect → Pair machine** and run `remi pair --relay` on the daemon machine.
Paste the complete token, or choose its QR image in the iOS/macOS app. The native
system picker and Vision decode the selected image locally; there is no upload.
The image must be at most 8 MiB, at most 4096 pixels on either axis and at most
8,388,608 pixels. Browser camera scanning uses BarcodeDetector where available;
otherwise paste the token. The native image picker does not capture from the
camera. Physical camera acceptance remains unrun.

Compare the client's displayed fingerprint on the daemon machine and approve
there. The client cannot approve itself. Close/Cancel ends the pending attempt.
Tokens live in the open form and one handshake, and are never saved. After the
verified ready exchange, only the Worker endpoint and machine public keys are
saved. Reconnecting uses the enrolled identity and a fresh handshake. If saving the
verified public pin fails because storage is full or the 64-machine limit is
reached, the client shows the error and disconnects without automatic resume.
Existing public pins remain. Resolve storage or forget a saved machine locally
before retrying explicitly.

`App → ConnectModal → RelayPairingForm → useConnectionManager.connectRelay →
RelayTransport → RelayMachineChannel` calls the shared v2 signer, handshake,
strict Worker codecs and counter-checked Channel. Session discovery and targeted
session hello requests travel through this one encrypted machine channel; the
client does not dial child ports or expose raw PTY transport. Device list/revoke
requests require a currently enrolled key and carry no local pairing capability.
Forgetting a public pin locally is separate from revoking daemon authorization.
A self-revocation can disconnect before an acknowledgment; that edge outcome is
unverified. Other-device revocation reports the actual correlated response.

An answer has a ten-second result deadline and no automatic retry. Its correlated
`answer_result` is delivery evidence, not evidence that a tool finished. An
uncertain outcome requires checking the daemon or terminal before answering
again.

The iOS/macOS device identity is stored and signs in the native Keychain provider.
WebKit accepts requests only from the exact bundled main document, using its
actual frame provenance. Native private bytes never return to TypeScript.
Legacy browser keys migrate inward only after an explicit conflict choice; native
persistence is verified before legacy cleanup. Protected imports retain the
native requirement for explicit foreground OS authentication, rather than
implicitly enabling background signing. Native storage uses device Keychain
protection; the old passphrase does not encrypt the native record. A macOS identity
replacement requires restarting its captured direct-client context.

Relay pairing is unavailable in the native Android app until it has a native
identity provider; it refuses before reading or creating a browser relay identity.
The existing Android direct connection path is unchanged. An Android browser is
a browser, and can use the browser provider where its crypto engine supports it.

Browser-only identities still use browser persistence, optionally encrypted with
a passphrase. This is not OS Keychain storage. Completed machine pins currently
remain public browser/WebView storage; R5 must establish native notification trust
anchors. Relay Worker URLs are not written into the existing native direct
`/answer` route; native relay lock-screen transport belongs to R6. Tests use
isolated Keychain namespaces, real WebCrypto/CryptoKit/Vision/WebKit and an owned
hub/Worker with controlled children. Unsigned simulator/desktop checks do not
establish signed iPhone, camera or device-authentication acceptance.
