# Authorizing a device: nearby, remote and fleet machines

A machine running remi lets a client in only if the client's Ed25519 public key is in that machine's authorized keys (since #873, with authentication on, which is the default).
There is one record for that, and three ways to put a key in it.
The ways differ in who is at the keyboard, never in what is trusted.

| Entry point | When | What the person does | What the machine does |
|---|---|---|---|
| **Nearby** | The phone or Mac is next to the machine | Run `remi pair`, scan the QR, type the first four characters of the phone's fingerprint | Claims the code for the first verified key and approves that key ([ADR 0037](../.context/decisions/0037-pairing-by-qr-with-terminal-approval.md); the app's scanner is #1283) |
| **Remote or manual** | The machine is reachable, the person has a terminal on it (SSH is enough) | Connect from the app, read its fingerprint, run `remi authorize <fingerprint> --label '<device name>'` there | Keeps the unknown key as pending for ten minutes, then approves exactly that key |
| **Fleet and ephemeral** | Many machines, or machines that are rebuilt | Export the device's public key once, run `remi authorize` with it as each machine is built | Authorizes the key before it ever connects; it is never pending |

All three end in the same record in `authorized_keys.json` (public key, fingerprint, label, when it was added and last used), written by the same code.
An exported key authorizes exactly the key it contains, and a pairing code authorizes nothing until the person has compared the fingerprint of the key that claimed it.
Nothing here reads, sends or stores a private key, and `remi authorize` accepts only public data.

## Terms

- **Client fingerprint:** the first 16 lowercase hexadecimal characters of the SHA-256 of the device's 32-byte public key. It names the device. An app shows all 16.
- **Machine fingerprint:** the same function over the machine's own key. A client sees it as `auth_challenge.serverFingerprint` (and the whole key as `serverPublicKey`). It names the machine, and a client that pins it notices when it changes. Never confuse the two: the person approves a *client* fingerprint on the machine, and compares a *machine* fingerprint on the device.
- **Label:** a name the person gives the device, such as "Work iPhone". It names the client, never the host. It is stored as given and shown by `remi keys`; it is not part of the identity, and another key with the same label gets nothing.

## Where a grant lives, and what it covers

A grant belongs to a machine's remi home: `~/.remi` of the user that runs remi, or the directory `REMI_HOME` names.
The hub (`remi serve`), every session daemon the hub starts, a wrapper (`remi`) and the `remi authorize` command all read and write the same files in that directory, under one interprocess lock.
Authentication reads the file each time (there is no cache), so a grant or a removal applies to the next fresh authentication without a restart, at the hub and at every session daemon.

So run `remi authorize` as the same user, and with the same `REMI_HOME`, as the hub.
A second user on the same machine, or a hub started with another `REMI_HOME`, has its own store and its own grants.
A service installed with `remi --install` uses the installing user's `~/.remi`.

## Remote or manual approval

1. The app connects and answers the machine's challenge with its key. A key the machine has not seen is refused with `auth_result{success:false, error:'UNKNOWN_KEY'}` and the connection is closed, and the key is kept as **pending**.
2. The app shows the person its own fingerprint and this command, with the label quoted for a POSIX shell:

   ```sh
   remi authorize <16-character fingerprint> --label '<device label>'
   ```

   `remi keys` on the machine lists every pending key with the same line (`remi authorize <fingerprint> --label device-name`).
3. The person runs it on the machine and compares the fingerprint the terminal and the app show. The command is not verification by itself: only the comparison is.
4. The app retries with a **fresh connection** (a challenge is single use) and is let in.

Rules the daemon enforces, and an app should build against:

- A pending key lives ten minutes from the first time it was seen. A retry does not extend it. After that, `remi authorize <fingerprint>` fails with "No unexpired pending key", and the next attempt makes a new one.
- `remi authorize <fingerprint>` takes the exact 16 lowercase hexadecimal characters, never a prefix, and approves only a pending key with that fingerprint.
- At most 32 keys wait at once, 4 of the slots kept for pairing claims. A full queue answers `PENDING_QUEUE_FULL`; an unreadable store answers `AUTH_STORE_ERROR`, which is worth a retry. Nothing else in `auth_result.error` is worth retrying without a change (`INVALID_SIGNATURE`, `FINGERPRINT_MISMATCH`, `INVALID_KEY_DATA`).
- Retry without hammering: for example every 5 seconds for the first minute and every 15 seconds after, with a Retry now button, and stop when the ten minutes have passed (say so, and offer to start again). A retry of a key that is already pending does not duplicate it.
- The machine does not push an approval to the app: the retry is how the app learns of it.
- Quote the label for the shell: wrap it in single quotes and write each `'` in it as `'\''`. A label may not start with `-` (the command refuses it), and an app should keep labels to plain text of 1 to 64 characters, the rule `remi pair` holds a phone's label to.

## Fleet and ephemeral machines: authorize before the first connection

The device exports its public key only. The JSON the CLI reads is:

```json
{"publicKey":"<the 32-byte key as canonical standard base64, 44 characters>"}
```

Other fields are ignored: a `fingerprint` in the JSON is for display and is never believed, the fingerprint is always derived from the key.
The machine then runs, as the user that runs remi:

```sh
remi authorize '{"publicKey":"<key>"}' --label 'Work iPhone'
# or, from a file:
remi authorize /etc/remi/devices/work-iphone.json --label 'Work iPhone'
```

This works before the hub has ever started (the machine makes its own identity on first start; the grant is already there) and while it runs (no restart).
The key is never a pending candidate, and `remi keys` lists it as authorized.
A key that is already authorized is refused with exit code 1 and "already authorized", leaving the one record, which a bootstrap script run twice needs to expect.
Edit no file in the remi home by hand: `remi authorize` takes the lock and checks the key.

A script for an image or a cloud-init `runcmd`, with one `<name>.json` per device in a directory (the file name is the label):

```sh
#!/bin/sh
# provision-devices.sh: pre-authorize every device public key found in a directory.
# Run as the user that runs `remi serve`, so the grants land in that user's remi home.
set -eu
dir=${1:-/etc/remi/devices}
status=0
for file in "$dir"/*.json; do
  [ -e "$file" ] || continue
  label=$(basename "$file" .json)
  if out=$(remi authorize "$file" --label "$label" 2>&1); then
    echo "authorized $label"
  else
    case "$out" in
      *"already authorized"*) echo "already authorized: $label" ;;
      *) echo "could not authorize $label: $out" >&2; status=1 ;;
    esac
  fi
done
exit "$status"
```

```yaml
#cloud-config
write_files:
  - path: /etc/remi/devices/work-iphone.json
    permissions: "0644"
    content: '{"publicKey":"<the device key>"}'
runcmd:
  # runcmd runs as root: run the script as the user that runs remi.
  - [sudo, -u, remi, /usr/local/bin/provision-devices.sh]
```

One device identity can be authorized on any number of machines this way, and a person's phone connects to each.
Each machine makes its own identity on first start, so a machine that is rebuilt presents a different machine fingerprint than the one it replaced: a client that pinned the old one will see the change, which is its correct response to a different machine.

## Rotation and revocation

- **Revoke:** `remi authorize --remove <fingerprint>`. The next fresh authentication with that key is refused (`UNKNOWN_KEY`) and the key is pending again, so approving it again restores access; a removed key is not banned and has no memory. Signed HTTP answers (lock-screen taps) check the grant on every request. **A connection that is already authenticated is not closed** by a removal: it stays until it closes (#1305).
- **Rotate:** a device that resets its identity (a reinstall, or "reset identity" in an app) makes a new key with a new fingerprint. The old grant does not carry over and is not removed: approve the new key, then remove the old one.
- **A stale pre-provisioned key** is a grant for a key whose device no longer exists, was reset or was lost. It still lets whoever holds the old private key in. Remove it with `--remove`; `remi keys` lists every grant with when it was added and last used.
- The export authorizes this device **wherever it is installed**: an image that carries a device's key lets that device in on every machine built from it, so keep the list to the devices that should have access.

## What the apps show

- The device's full 16-character fingerprint and its label, and the export (copy and share) of the public-only JSON above, with a plain statement that it contains no private key and authorizes this device wherever it is installed.
- On `UNKNOWN_KEY`: the machine being authorized (its name and address, and the machine fingerprint it signed with), the device fingerprint, and the command above.
- A bounded retry after approval, and a Retry now button.
- Never the private key, in any form, and never an instruction to edit `authorized_keys.json`.

## What this does not change

The direct WebSocket is not encrypted by remi ([ADR 0009](../.context/decisions/0009-transport-encryption-scope.md)): provisioning a key authenticates a device, it does not protect the traffic.
Public keys are safe to distribute, and installing one grants that device access.

## Where it is tested

`packages/daemon/tests/integration/key-provisioning.test.ts` runs real hubs and the real `remi authorize` for each statement above, and `first-connect-process.test.ts` and `pair-hub.test.ts` cover the approval and pairing paths.
The provisioning script on this page is run from this file by the first of them.
