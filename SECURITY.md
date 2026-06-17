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
