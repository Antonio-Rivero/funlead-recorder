# Security Policy

## Reporting a vulnerability

Please report security issues privately via the contact form at
[funlead.app](https://funlead.app) rather than opening a public issue. We will
respond as quickly as we can.

## What this project does with your data

The desktop app is local-first and makes no network calls by default. It does not
collect telemetry. The optional web server is self-hosted by you; your recordings and
analytics live on infrastructure you control.

## What never gets committed

This repository enforces a privacy gate (`scripts/secret-scan.sh` + gitleaks, run on
every commit). The following must never be committed: real secrets (database URLs,
storage/API tokens, signing identities), private personal data, internal infrastructure
hostnames, or any third-party / customer data. See `CONTRIBUTING.md`.

## Supply chain

Build scripts and CI pin exact upstream versions and verify integrity before use (no
moving "latest"): the static ffmpeg binary and the whisper model are SHA256-verified,
`whisper.cpp` is pinned by tag + commit, GitHub Actions are pinned to commit SHAs, and
`gitleaks` is pinned and SHA256-verified. Verification is fail-closed. See
`CONTRIBUTING.md` for how to re-pin.

Released desktop binaries are currently **unsigned and not notarized** (no Apple
Developer cert required); integrity rests on HTTPS delivery plus a draft-then-human-verify
step before each release is published. See `.github/workflows/release.yml`.
