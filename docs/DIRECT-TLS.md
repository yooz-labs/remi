# Direct HTTPS/WSS

The daemon can serve its public HTTP and WebSocket routes over TLS.
Device authorization remains required when authentication is enabled;
TLS does not replace `remi authorize` or local pairing approval.
The default listener remains `ws://` without encryption by Remi.

## Configure the host

Use a certificate valid for the hostname or IP address your client will dial,
with an issuer that the client trusts. Remi reads the PEM files; it does not
provision certificates or install trust anchors.

Add this to the host's `config.toml`, using your own paths:

```toml
[daemon]
bind = "0.0.0.0"

[daemon.tls]
certificate_file = "tls/server-cert.pem"
private_key_file = "tls/server-key.pem"
```

Relative paths resolve against the directory containing `config.toml`, including
when a session runs in another project directory. Absolute paths also work.
Both fields are required together; unknown TLS fields and invalid paths are
refused. Keep the private key readable only by its owner.

Start or restart the hub with authentication enabled:

```sh
remi serve --auth
```

Use the public port printed by Remi and a WSS-capable client, for example
`wss://your-host.example:18765/ws`. The certificate must match the actual dialed
hostname or IP. Keep normal certificate and hostname verification enabled.

Certificates are loaded once at startup. Restart after replacing either file.
Missing, unreadable, invalid or mismatched configured material stops startup;
the daemon and wrapper do not fall back to a plaintext public listener.

## Local commands

Local attach, detach, list, recent, kill, session creation and relay control
commands select the same Remi home's private loopback connection automatically.
The hub also uses it for verified local child sessions. The internal endpoint
is not a public connection address; public machine/session ports stay public.
An invalid or stale endpoint record refuses the local connection.

Remote CLI targets keep their existing WS behavior and receive no host-local
capability. Remote CLI WSS adoption is a separate phase. An SSH tunnel to the
TLS public port still requires a WSS-capable client at its other end.

## Current client and discovery limits

Legacy mDNS does not advertise a configured TLS listener. When a same-PID local
endpoint record confirms TLS, direct v1 `remi pair` refuses because its QR payload
cannot describe the secure endpoint. A missing record establishes no transport
mode; it does not make the TLS listener accept plaintext. Local relay
pairing/control uses the private connection.

The web connection manager preserves an existing WSS scheme and certificate
hostname during child discovery and reconnect probing. Full rendered secure
connection acceptance, native endpoint/QR adoption and operator certificate
provisioning remain separate gates. Existing clients that construct only WS URLs
need their TLS adoption before they can use a configured public TLS listener.

The new browser-link and file-download capabilities remain unavailable until
their actual handlers and clients are integrated and verified. Their release
requires HTTPS/WSS; the accepted download ceiling remains 10 MiB.
