# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report privately through **GitHub Security Advisories**:

> **<https://github.com/AbdulrahmanHR/OmniLink/security/advisories/new>**

That form is visible only to the maintainer. It lets us discuss, fix, and
coordinate disclosure before any detail is public, and it can issue a CVE if one is
warranted.

If you cannot use the advisory form for some reason, contact the maintainer
privately through GitHub at <https://github.com/AbdulrahmanHR>. **OmniLink publishes
no email address** — GitHub is the project's only contact channel, deliberately.

### What to include

The more of this you can supply, the faster a fix lands:

- What the issue is and what an attacker gains from it.
- Steps to reproduce, or a proof of concept.
- The affected version (Settings → About, or the installer filename).
- Your OS and version.
- **If hardware is involved:** the radio/RX brand and model, its ExpressLRS firmware
  version, and the connection mode (serial / WiFi / Backpack).
- Whether the issue is already public anywhere.

---

## Why OmniLink's threat model is unusual: it writes firmware to hardware

**This is the most important section of this file.**

Most desktop apps can, at worst, damage data. OmniLink erases and rewrites the flash
memory of radio-control hardware that flies. A defect in a flash path can brick a
transmitter or receiver, and — because a receiver governs failsafe and control link
behaviour — can in the worst case contribute to a loss-of-control event on an
aircraft in the air, near people.

**Accordingly, the highest-severity class of vulnerability in OmniLink is anything
that lets the wrong bytes reach a device, or that leaks a binding secret.**

Issues in the following areas are treated as **critical** and get priority over
everything else, including feature work:

### Flash path

- Any bypass of the **pre-flash guard** that keeps a TX-target image off an RX device
  (or vice versa), or that keeps TX-Backpack and VRX-Backpack images apart.
- Any way to make OmniLink flash an image that is not the one the user selected and
  reviewed — including target-name aliasing, catalogue substring collisions, or a
  guard that evaporates on retry.
- Any path that writes to a device the user did not choose — for example, port
  re-selection while a just-flashed board re-enumerates.
- Tampering with the firmware download or verification path: redirect following to
  an unexpected host, downgrade from HTTPS, a defeated integrity check, or a
  substituted artifact.
- Anything reaching the **MSP passthrough** path that could put a flight controller
  into an unintended mode, energize motor outputs, or talk to the wrong bus.
- Memory-safety or resource-exhaustion faults reachable from a firmware image,
  a `.bbl` log, or a device response — anything parsing untrusted bytes.

### Binding phrase and secrets

- Any leak of a **binding phrase** or the UID derived from it — into logs, crash
  dumps, an AI prompt, an exported profile, a support report, a telemetry CSV, or an
  error message.
- Any leak of a **BYOK API key** out of OS-keychain storage, or any path that
  returns a key to the frontend. The frontend is only ever entitled to a boolean.
- Any defeat of `sanitize_context()` — the scrubber that keeps binding phrases, GPS
  coordinates, MAC addresses, IP addresses and email addresses out of anything sent
  to an AI provider. Prompt-injection that escapes the untrusted-content fence and
  escalates trust belongs in this class.
- Any way to make the AI suggestion validator write a safety-critical field (RF
  power, failsafe, arming, binding secret). The validator is closed and
  deny-by-default; a bypass is critical.

### Other in-scope areas

- Path traversal or arbitrary file write/read via profile names, imported documents,
  log files, or tile packs.
- Command injection into the PlatformIO/esptool subprocess bridge.
- Weaknesses in the updater's minisign signature verification, or anything allowing
  an unsigned or downgraded update to install.
- Local privilege escalation through the shipped Linux udev rule or the installers.

### Out of scope

- Missing OS code-signing on the installers. **This is a known, documented state**,
  not a vulnerability — SmartScreen and Gatekeeper warn on first launch. See
  `README.md`.
- Vulnerabilities in an LLM provider's own service. OmniLink is BYOK; you are
  calling your provider with your key.
- Physical attacks requiring the attacker to already have your unlocked machine.
- Findings from automated scanners with no demonstrated impact on OmniLink.
- Social engineering of the maintainer or of contributors.
- The `pubkey` in `tauri.conf.json` — that is the **public** half of the updater
  signing key and is public by design.
- Denial of service that requires the user to deliberately import an absurd file.

---

## Response window — stated honestly

OmniLink is maintained by **one unpaid person, in their spare time**. There is no
security team, no on-call rotation, and no service-level agreement. Please calibrate
expectations accordingly:

| Stage | Target | Realistic |
|-------|--------|-----------|
| Acknowledgement that your report was received | 7 days | usually within a few days; longer if life intervenes |
| Initial assessment and severity call | 14 days | |
| Fix for a **critical** flash-path or secret-leak issue | as fast as possible — this jumps the queue ahead of all feature work | days to a few weeks |
| Fix for other issues | best effort, typically the next release | can be longer |

**If you have not had any response within 21 days**, please ping the advisory
thread — it means the notification was missed, not that the report was dismissed.

These are honest targets from a solo maintainer, not a guarantee. If a critical
issue exceeds them, the honest outcome is a public advisory describing the risk and
a workaround, so users can protect themselves even before a fix ships.

---

## Supported versions

Only the **latest released version** receives security fixes. There are no
long-term-support branches — a solo maintainer cannot credibly backport, and
pretending otherwise would be worse than saying so.

The in-app updater (Settings → App Update) is the fastest way to get a fix; updater
artifacts are minisign-signed and verified before installation.

---

## Disclosure

Preferred process:

1. You report privately through the advisory form.
2. We agree on the severity and a fix.
3. A fixed release ships.
4. The advisory is published, crediting you unless you prefer otherwise, and the
   `CHANGELOG.md` entry records the fix.

Please give a fix a reasonable chance to ship before disclosing publicly.
**Coordinated disclosure within 90 days** is the default expectation; for an issue
that can put firmware on the wrong hardware, please talk to us first regardless of
how much time has passed. This tool touches things that fly.

If you report a genuine issue in good faith, no action will be taken against you.
There is no bug bounty — OmniLink has no revenue and never will — but credit in the
advisory and the changelog is offered gladly.
