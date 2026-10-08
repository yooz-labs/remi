# Authorizing a device: nearby, remote and fleet machines

Since #873, with authentication on (the default), a machine running remi lets a client in only if the client's Ed25519 public key is in that machine's authorized keys.
The one other way in is a local process that can read the machine's `capability.key` file and presents it over a loopback connection.
There is one record for the keys, and three ways to put a key in it.
The ways differ in who is at the keyboard, never in what is trusted.

| Entry point | When | What the person does | What the machine does |
|---|---|---|---|
| **Nearby** | The phone or Mac is next to the machine | Run `remi pair`, scan the QR, type the first four characters of the phone's fingerprint | Claims the code for the first verified key and approves that key ([ADR 0037](../.context/decisions/0037-pairing-by-qr-with-terminal-approval.md)) |
| **Remote or manual** | The machine is reachable and the person has a terminal on it (SSH is enough) | Connect from the app, read its fingerprint, run `remi authorize <fingerprint> --label '<device name>'` there | Keeps the unknown key as pending for ten minutes, then approves exactly that key |
| **Fleet and ephemeral** | Many machines, or machines that are rebuilt | Export the device's public key once, run `remi authorize` with it as each machine is built | Authorizes the key before it ever connects; it is never pending |

No released app scans the pairing code yet: the Swift scanner reads a superseded format (#1283).
Use the remote path even when the phone is next to the machine.

The three ways share one record format in `authorized_keys.json`: public key, fingerprint, label, when it was added and when it was last used.
An import goes through `addAuthorizedKey`, and approving a pending key and approving a pairing both go through `commitAuthorizationInsideTransaction`.
All three build the record with `createAuthorizedKey` and write it with `writeAuthorizedKeys`.
An exported key authorizes exactly the key it contains.
A pairing code authorizes nothing until the person has compared the fingerprint of the key that claimed it.

`remi authorize` is for public keys, and it does not enforce that.
It takes the `publicKey` out of whatever JSON it is given and ignores every other field.
It does not refuse a file that holds a private key, so a full `remi export-key` identity is accepted (#1320).
Only `remi export-key --public-only` output, or an app's public-only export, belongs in a devices directory.
The cloud-init example below writes device files with mode 0644, so a private key exported by mistake would be left readable by every user on the machine.

## Terms

- **Client fingerprint:** the first 16 lowercase hexadecimal characters of the SHA-256 of the device's 32-byte public key.
  It names the device.
  An app shows all 16 characters.
- **Machine fingerprint:** the same function over the machine's own key.
  A client sees it as `auth_challenge.serverFingerprint`, and the whole key as `serverPublicKey`.
  It names the machine.
- **Label:** a name the person gives the device, such as "Work iPhone".
  It names the client, never the host.
  It is stored as given and is not part of the identity, so another key with the same label gets nothing.
  `remi keys` cuts it to 16 characters and prints it as it is stored (#1321).

The person approves a *client* fingerprint on the machine, and compares a *machine* fingerprint on the device.
Never confuse the two.

The machine fingerprint in `auth_challenge` is announced, not proven, until the key is approved: the machine signs the challenge only for a key it lets in, so a refused client has only the machine's claim.
A person reads the real machine fingerprint on the machine itself: in the hub's startup line `Authentication enabled (fingerprint: ...)`, in `remi pair`, or with `remi export-key --public-only`.
A fleet machine has no identity until its first start, so a device's first contact with such a machine is trust on first use of the machine's key.

## Where a grant lives, and what it covers

A grant belongs to a machine's remi home: `$HOME/.remi` of the process that runs remi, or the directory `REMI_HOME` names.
A process with another `HOME`, such as a second user or a service that sets its own, has a different store.
The hub (`remi serve`), every session daemon the hub starts, a wrapper (`remi`) and the `remi authorize` command all use the same files in that directory.
Writes (`remi authorize`, a key's last-used stamp, a pending key) take one interprocess lock.
Reads take none, and rely on every write being an atomic rename.
Authentication reads `authorized_keys.json` each time, with no cache.
So a grant or a removal applies to the next fresh authentication, at the hub and at every session daemon, with no restart.

Run `remi authorize` as the same user, and with the same `REMI_HOME`, as the hub.
A service installed with `remi --install` uses the installing user's `$HOME/.remi`.

## Remote or manual approval

1. The app connects and answers the machine's challenge with its key.
   A key the machine has not seen is refused with `auth_result{success:false, error:'UNKNOWN_KEY'}`, the connection is closed, and the key is kept as **pending**.
2. The app shows the person its own fingerprint and this command, with the label quoted for a POSIX shell:

   ```sh
   remi authorize <16-character fingerprint> --label '<device label>'
   ```

   `remi keys` on the machine lists every pending key with the same line (`remi authorize <fingerprint> --label device-name`).
3. The person runs it on the machine and compares the fingerprint the terminal and the app show.
   The command is not verification by itself, only the comparison is.
4. The app retries with a **fresh connection**, because a challenge is single use, and is let in.

Rules the daemon enforces, which an app builds against:

- A pending key lives ten minutes from the first time it was seen.
  A retry does not extend it.
  After that, `remi authorize <fingerprint>` fails with "No unexpired pending key", and the next attempt makes a new one.
- `remi authorize <fingerprint>` takes the exact 16 lowercase hexadecimal characters, never a prefix, and approves only a pending key with that fingerprint.
- At most 32 keys wait at once, and four of the slots are kept for pairing claims.
  A full queue answers `PENDING_QUEUE_FULL`.
  An unreadable store answers `AUTH_STORE_ERROR`.
- In this manual flow, `PENDING_QUEUE_FULL` and `AUTH_STORE_ERROR` are worth a retry.
  `INVALID_SIGNATURE`, `FINGERPRINT_MISMATCH`, `INVALID_KEY_DATA`, `NO_PENDING_CHALLENGE`, `VERIFICATION_ERROR` and `SERVER_SIGN_ERROR` are not, without a change.
  The `PAIRING_*` codes belong to the pairing flow, which retries `PAIRING_PENDING` ([ADR 0037](../.context/decisions/0037-pairing-by-qr-with-terminal-approval.md)).
- Retry without hammering, for example every 5 seconds for the first minute and every 15 seconds after, with a Retry now button.
  Stop when the ten minutes have passed, say so, and offer to start again.
  A retry of a key that is already pending does not duplicate it.
- The machine does not push an approval to the app, so the retry is how the app learns of it.
- Quote the label for the shell: wrap it in single quotes, and write each `'` in it as `'\''`.
  A label may not be empty or start with `-`, because the command refuses it with "--label requires a value".
  Keep labels to plain text of 1 to 64 characters, the rule `remi pair` holds a phone's label to.
  If the person pastes the command into a terminal, strip control characters and line breaks from the label first.

## Fleet and ephemeral machines: authorize before the first connection

The device exports its public key only.
The JSON the CLI reads is:

```json
{"publicKey":"<the 32-byte key as canonical standard base64, 44 characters>"}
```

Other fields are ignored.
A `fingerprint` in the JSON is for display and is never believed, because the fingerprint is always derived from the key.
The machine then runs, as the user that runs remi:

```sh
remi authorize '{"publicKey":"<key>"}' --label 'Work iPhone'
# or, from a file:
remi authorize /etc/remi/devices/work-iphone.json --label 'Work iPhone'
```

This works before the hub has ever started (the machine makes its own identity on first start, and the grant is already there) and while it runs (no restart).
The key is never a pending candidate, and `remi keys` lists it as authorized.
A key that is already authorized is refused with exit code 1 and "already authorized", leaving the one record.
A bootstrap script run twice has to expect that.
Edit no file in the remi home by hand, because `remi authorize` takes the lock and checks the key.

A script for an image or a cloud-init `runcmd`, with one `<name>.json` per device in a directory (the file name is the label):

```sh
#!/bin/sh
# provision-devices.sh: pre-authorize every device public key found in a directory.
# Run as the user that runs `remi serve`, so the grants land in that user's remi home.
set -eu
dir=${1:-/etc/remi/devices}
[ -d "$dir" ] || { printf '%s\n' "no such directory: $dir" >&2; exit 2; }
status=0
found=0
for file in "$dir"/*.json; do
  [ -e "$file" ] || continue
  found=1
  label=$(basename "$file" .json)
  if out=$(remi authorize "$file" --label "$label" 2>&1); then
    printf '%s\n' "authorized $label"
  else
    case "$out" in
      *"already authorized"*) printf '%s\n' "already authorized: $label" ;;
      *) printf '%s\n' "could not authorize $label: $out" >&2; status=1 ;;
    esac
  fi
done
if [ "$found" = 0 ]; then
  printf '%s\n' "no device files (*.json) in $dir" >&2
  exit 2
fi
exit "$status"
```

What the script does and does not do:

- It only adds.
  Deleting a device's file, or replacing its content with another key, leaves the old key authorized on every machine already provisioned.
  Remove it there with `remi authorize --remove <fingerprint>`.
- Running it again never relabels.
  A file renamed for a key that is already authorized prints `already authorized: <new name>`, and the stored label stays the old one.
- A missing or empty directory is an error (exit 2), so a bootstrap that lost its devices fails instead of provisioning nothing.

The same script in a cloud-init file:

```yaml
#cloud-config
write_files:
  - path: /etc/remi/devices/work-iphone.json
    permissions: "0644"
    content: '{"publicKey":"<the device key>"}'
  - path: /usr/local/bin/provision-devices.sh
    permissions: "0755"
    content: |
      #!/bin/sh
      # provision-devices.sh: pre-authorize every device public key found in a directory.
      # Run as the user that runs `remi serve`, so the grants land in that user's remi home.
      set -eu
      dir=${1:-/etc/remi/devices}
      [ -d "$dir" ] || { printf '%s\n' "no such directory: $dir" >&2; exit 2; }
      status=0
      found=0
      for file in "$dir"/*.json; do
        [ -e "$file" ] || continue
        found=1
        label=$(basename "$file" .json)
        if out=$(remi authorize "$file" --label "$label" 2>&1); then
          printf '%s\n' "authorized $label"
        else
          case "$out" in
            *"already authorized"*) printf '%s\n' "already authorized: $label" ;;
            *) printf '%s\n' "could not authorize $label: $out" >&2; status=1 ;;
          esac
        fi
      done
      if [ "$found" = 0 ]; then
        printf '%s\n' "no device files (*.json) in $dir" >&2
        exit 2
      fi
      exit "$status"
runcmd:
  # runcmd runs as root. -H gives the script the remi user's HOME, so the grants land in its ~/.remi.
  - [sudo, -H, -u, remi, /usr/local/bin/provision-devices.sh]
```

`sudo` resets the environment, so this example uses the default `$HOME/.remi` of the user `remi`.
For another remi home, pass it through: `sudo -H -u remi env REMI_HOME=/var/lib/remi /usr/local/bin/provision-devices.sh`.

One device identity can be authorized on any number of machines this way.
Each machine makes its own identity on first start, so a machine that is rebuilt presents a different machine fingerprint than the one it replaced.
A client that pinned the old one sees the change, which is its correct response to a different machine.

### Two things to get right on a fleet

- **Reachability.**
  A stock hub binds `127.0.0.1` (#880), so a machine provisioned exactly as above cannot be reached by a phone.
  Set `daemon.bind` (with authentication on, never `--no-auth`) or use an SSH tunnel; see Connection Methods in the [README](../README.md).
  Do not use `tailscale serve`, which loses the peer's address (the warning is in the README's Features list).
- **Do not bake the machine's state into an image.**
  After a first start, the remi home holds `identity.json` (the machine's private key, unencrypted by default) and `capability.key`.
  An image captured after that makes every clone share one machine identity and one capability token.
  Capture the image before remi first runs, and provision keys as each machine boots.

## Rotation and revocation

- **Revoke:** `remi authorize --remove <fingerprint>`.
  The next fresh authentication with that key is refused (`UNKNOWN_KEY`), and the key is pending again, so approving it again restores access.
  A removed key is not banned and has no memory.
  Signed HTTP answers (lock-screen taps) check the grant on every request.
- **A connection that is already authenticated is not closed by a removal** (#1305).
  That device keeps full access, including answering approval cards, until its socket closes.
  The only way to end it today is to stop the daemon process that holds the socket.
  `remi stop --all` stops the hub and every session daemon, so it also ends those sessions; this has not been exercised here against an open socket.
- **Rotate:** a new device, or a restore onto one, has a new key with a new fingerprint.
  The old grant does not carry over and is not removed.
  Approve the new key, then remove the old one.
  No native app has a "reset identity" feature today; a future one would work the same way.
- **A stale pre-provisioned key** is a grant for a key whose device no longer exists, was replaced or was lost.
  It still lets in whoever holds the old private key.
  Remove it with `--remove`; `remi keys` lists every grant with when it was added and last used.
- The export authorizes this device wherever it is installed.
  An image or a script that carries a device's key lets that device in on every machine built from it, so keep the list to the devices that should have access.

## What an app should show

This guide is the specification an app is held to.
Part of it ships, and the lists below say which.

Shipped:

- The device's public-only JSON export, on iPhone (#1304) and Mac (#1311).
- The command with the label single-quoted, through `PublicClientIdentity.authorizeCommand(label:)`.
- The iPhone's approval screen shows the machine's name and the device fingerprint, can copy the command, and has a Retry connection button.

Not shipped:

- Automatic retry after approval.
  The native client stops at `awaitingLocalApproval` with `shouldRun` false, and only the manual button restarts it (#1303 keeps its retry items open).
- The machine fingerprint on that screen.
- A bounded backoff, and the stop at ten minutes.

Where the shipped code differs from the rules above, and an app should be brought in line (the native code is not changed by this guide):

- `PublicClientIdentity.authorizeCommand(label:)` does not limit the label to 64 code points and does not handle a label that starts with `-`, which the CLI refuses.
  It collapses runs of white space and falls back to `device` for an empty label.
- `ClientIdentity.authorizeCommand` is the older unquoted form, `remi authorize <fingerprint> --label device`.
  It should not be shown.

What an app should show:

- The device's full 16-character fingerprint and its label.
- A copy and share of the public-only JSON above, with a plain statement that it holds no private key and authorizes this device wherever it is installed.
- On `UNKNOWN_KEY`, the machine being authorized (its name and address, and its announced machine fingerprint), the device fingerprint, and the command above.
- A bounded retry after approval, and a Retry now button.
- Never the private key, in any form, and never an instruction to edit `authorized_keys.json`.

## What this does not change

The direct WebSocket is not encrypted by remi ([ADR 0009](../.context/decisions/0009-transport-encryption-scope.md)).
Provisioning a key authenticates a device, and it does not protect the traffic.
Public keys are safe to distribute, and installing one grants that device access.

## Where it is tested

`packages/daemon/tests/integration/key-provisioning.test.ts` runs real hubs and the real `remi authorize` for most statements above.
The other half is in `first-connect-approval.test.ts` (the pending lifetime, the 32-slot queue, `PENDING_QUEUE_FULL` and `AUTH_STORE_ERROR`), `first-connect-process.test.ts` and `pair-hub.test.ts`.
The provisioning script on this page, and its copy in the cloud-init example, are read from this file and run by the first of them.
