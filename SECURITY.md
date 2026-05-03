# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **dev@yooz.info** with:

- A clear description of the issue.
- A minimal reproduction (steps, code, network requests, etc.) if you have one.
- Affected version(s) and your environment (OS, browser, device).
- Your name and contact for follow-up. We're happy to credit you in the fix announcement if you'd like.

We aim to acknowledge within **2 business days** and provide a triage decision (accepted / needs more info / not a security issue) within **5 business days**.

## Disclosure timeline

We follow **coordinated disclosure**:

1. You report → we acknowledge within 2 business days.
2. We triage and confirm within 5 business days.
3. We develop + test a fix. Standard fix window: **30 days** for critical / high, **60 days** for medium, **90 days** for low.
4. We coordinate the disclosure date with you. Default: full public disclosure with credit to the reporter when the fix ships.
5. We may request you withhold public disclosure until the fix is shipped. We will not silently delay; we'll communicate the timeline.

## Out of scope

- Vulnerabilities in third-party dependencies where the upstream project is the right place to report. We track upstream security advisories and update.
- Issues that require physical access to the user's unlocked device.
- DoS via local processes that already have user-level privileges.
- Self-XSS or social-engineering scenarios that require the user to actively cooperate with the attacker.
- Findings on test fixtures, sample data, or development-only code paths.

## Hall of Fame

We'll list reporters with their permission once we've shipped fixes.

---

For non-security questions or general issues, please use **GitHub Issues**.
