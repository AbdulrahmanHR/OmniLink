# Windows code signing — the "unknown publisher" and firewall warnings

This document explains the two separate Windows warnings users hit when they
run the OmniLink installer or let the in-app updater ("the downloader") fetch a
release, and exactly how to make each one go away.

> **Status:** scaffolding + reference only. The shipped builds are **not**
> Authenticode-signed (`bundle.windows.certificateThumbprint` is `null` in
> `src-tauri/tauri.conf.json`), so SmartScreen currently warns. Nothing in the
> source removes that warning on its own — it requires a trusted code-signing
> certificate. This file is the playbook for wiring one in once you have it.

---

## The two warnings are unrelated — don't confuse them

| What the user sees | Real cause | Fix |
|---|---|---|
| **"Windows protected your PC" / "unknown publisher" / "not safe"** (SmartScreen, blue box) | The `.exe`/`.msi` is not Authenticode code-signed. | A trusted **code-signing certificate** (below). No source change alone fixes it. |
| **"Do you want to allow OmniLink to communicate on these networks?"** (Windows Defender Firewall) | The app opens a network socket: mDNS browse of `_http._tcp.local.` (UDP 5353) and a connection to the ELRS device's WiFi self-AP at `10.0.0.1` to flash firmware. See `src-tauri/src/commands/wifi.rs`. | **Expected. Click *Allow* (Private networks is enough).** It is a normal networked-app prompt, not a malware warning. Signing the binary also makes this prompt show a verified publisher name. Optional suppression at the bottom. |

The rest of this doc is about the first one (SmartScreen), which is the one that
reads as "not safe."

---

## Two different "signings" in this repo — also don't confuse them

1. **Updater artifact signing (minisign).** `TAURI_SIGNING_PRIVATE_KEY` +
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets, paired with the `pubkey` in
   `tauri.conf.json` → `plugins.updater`. This is **already wired and required**
   (`createUpdaterArtifacts` is on). It proves an update bundle came from this
   project so the M22 updater will accept it. **It does NOT touch SmartScreen.**
2. **Authenticode code signing.** Signs the `.exe`/`.msi` with a certificate
   Windows trusts, so SmartScreen recognizes the publisher. This is what silences
   the "unknown publisher / not safe" warning. It is currently **off**
   (`certificateThumbprint: null`).

Everything below is about (2).

---

## Certificate routes

Pick one. They differ in cost, how fast SmartScreen stops warning, and how they
wire into the build.

### A. Azure Trusted Signing — recommended

- ~US$9.99/month, cloud-based, **no hardware token**. Individual or org identity
  validation. Earns SmartScreen reputation like a standard OV cert (not instant,
  but no HSM hassle and the cheapest ongoing).
- Signs via a **`signCommand`** that Tauri invokes for each bundled artifact,
  using the [`trusted-signing-cli`](https://github.com/Levminer/trusted-signing-cli)
  tool. Nothing lives in the Windows cert store, so it works cleanly in CI.

`src-tauri/tauri.conf.json` → `bundle.windows` (add alongside the existing keys;
**verify the file-path placeholder and CLI flags against the current Tauri v2 +
trusted-signing-cli docs** before trusting them — both have drifted across
versions):

```jsonc
"windows": {
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com",
  "certificateThumbprint": null,
  "signCommand": {
    "cmd": "trusted-signing-cli",
    "args": [
      "-e", "https://<region>.codesigning.azure.net",
      "-a", "<trusted-signing-account>",
      "-c", "<certificate-profile>",
      "-d", "OmniLink",
      "%1"
    ]
  }
}
```

`%1` is the artifact path Tauri passes in. Keep `certificateThumbprint: null`
when using `signCommand` — they are mutually exclusive routes.

CI (in `.github/workflows/release.yml`, before the `tauri-apps/tauri-action`
step on the Windows leg): install the CLI and authenticate via an Azure service
principal, then let tauri-action run the build (it invokes `signCommand`):

```yaml
- name: Install trusted-signing-cli (Windows)
  if: matrix.platform == 'windows-latest'
  run: cargo install trusted-signing-cli
- name: Azure login (Windows)
  if: matrix.platform == 'windows-latest'
  uses: azure/login@v2
  with:
    creds: ${{ secrets.AZURE_CREDENTIALS }}
```

Secrets to add (Settings → Secrets and variables → Actions): `AZURE_CREDENTIALS`
(service-principal JSON), plus the endpoint/account/profile if you'd rather pass
them as env than hardcode in `tauri.conf.json`.

### B. EV certificate — instant SmartScreen trust

- ~US$250–400/year, org identity required, ships on a **hardware token or cloud
  HSM**. The one route where SmartScreen trusts the binary **immediately**, with
  no download-reputation warm-up. Best if OmniLink is a registered organization
  and you want zero warnings on day one.
- A physical token can't be plugged into a GitHub-hosted runner, so either sign
  on a **self-hosted Windows runner** with the token attached, or use the CA's
  **cloud-HSM** signing (DigiCert KeyLocker, SSL.com eSigner, etc.), which is
  driven through a `signCommand` much like route A.

### C. OV (standard) certificate — cheapest cert, slow to silence

- ~US$100–200/year. Same wiring as EV (either `certificateThumbprint` with the
  cert imported into the runner's store, or a cloud-HSM `signCommand`).
- **Caveat:** a fresh OV cert has no reputation, so SmartScreen keeps warning
  until the signed installer accumulates enough downloads over days/weeks. The
  warning fades; it isn't gone on day one.

### Thumbprint route (EV/OV with the cert in the runner store)

If you sign with a `.pfx` imported into the Windows cert store instead of a
`signCommand`, set the thumbprint and import the cert in a pre-build step:

```jsonc
// tauri.conf.json → bundle.windows
"certificateThumbprint": "${WINDOWS_CERT_THUMBPRINT}"
```

```yaml
# release.yml, Windows leg, before tauri-action
- name: Import code-signing cert (Windows)
  if: matrix.platform == 'windows-latest' && env.WINDOWS_CERT_PFX_BASE64 != ''
  shell: pwsh
  env:
    WINDOWS_CERT_PFX_BASE64: ${{ secrets.WINDOWS_CERT_PFX_BASE64 }}
    WINDOWS_CERT_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
  run: |
    $pfx = [IO.Path]::GetTempFileName() + ".pfx"
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX_BASE64))
    $pw = ConvertTo-SecureString $env:WINDOWS_CERT_PASSWORD -AsPlainText -Force
    Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $pw
    Remove-Item $pfx
```

The `env != ''` guard keeps the build **unsigned-but-passing** when the secret
is absent — so adding this step does not break existing runs.

---

## Verify a signed build

```powershell
signtool verify /pa /v .\OmniLink_3.0.2_x64-setup.exe
```

Or right-click the `.exe` → **Properties → Digital Signatures** — your identity
should be listed. After signing, SmartScreen stops warning **immediately** for
EV/Azure-with-reputation, or **once download reputation accrues** for a fresh
OV cert.

---

## Optional: suppress the firewall prompt

The firewall prompt is harmless and clicking *Allow* is the intended path. If you
want to avoid it entirely, the NSIS installer can pre-create a firewall rule with
an installer hook:

```nsis
; Runs during install (needs admin, which the installer already has)
nsExec::Exec 'netsh advfirewall firewall add rule name="OmniLink" \
  dir=in action=allow program="$INSTDIR\OmniLink.exe" enable=yes profile=private'
```

Wire it via `bundle.windows.nsis.installerHooks` in `tauri.conf.json`. **Left
off by default on purpose:** silently opening a firewall port is a worse default
than a one-time, user-visible *Allow* prompt. Only add it if your users
specifically ask for a promptless install.

---

## Summary

- The "not safe / unknown publisher" warning = **no Authenticode signature**.
  Fix = a code-signing certificate (Azure Trusted Signing is the best value;
  EV for instant trust; OV is cheap but slow to earn trust), then wire it via
  `signCommand` or `certificateThumbprint` and the CI snippets above.
- The firewall prompt = the app's mDNS + WiFi-flashing network use. **Expected;
  click Allow.**
- The existing `TAURI_SIGNING_PRIVATE_KEY` secret is **updater** signing, a
  separate concern that does not affect SmartScreen.
