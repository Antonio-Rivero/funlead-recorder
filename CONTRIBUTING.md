# Contributing

Thanks for helping improve FunLead Recorder.

## Privacy gate (required)

This repo was extracted from private codebases, so every commit runs a two-layer scan to
guarantee nothing private leaks:

1. **gitleaks** — catches generically secret-shaped tokens (keys, connection strings).
2. **`scripts/secret-scan.sh`** — catches what gitleaks does *not*: secret-shaped tokens,
   generic personal-data shapes, forbidden network calls, and (locally) any
   project-specific private strings. We deliberately do not re-implement the generic
   token patterns that `gitleaks --useDefault` already covers, to avoid drift.

The project **brand** ("FunLead", "funlead.app") is intentional and allowed; the gate
never blocks it.

### Private patterns live outside the repo

The committed scanner ships only **generic** rules. Project-specific private strings —
real client/brand names, signing identities, internal repo/host names, private backend
symbols — must never be committed (publishing them would leak exactly what the gate
protects). They load at runtime from an **unversioned** file:

```bash
cp .private-secret-patterns.example .private-secret-patterns   # gitignored
# edit it with your real values (see the format inside)
```

`scripts/secret-scan.sh` loads `.private-secret-patterns` automatically when present, so
your local pre-commit gate has full coverage. On a public clone the file is absent and
only the generic rules run — by design. You can point the scanner at another file with
`PRIVATE_PATTERNS_FILE=/path/to/file`.

### Install the pre-commit hook

```bash
brew install gitleaks lefthook   # if not already installed
lefthook install
```

Now `git commit` runs the gate locally. To run it manually:

```bash
bun run scan && gitleaks detect --config .gitleaks.toml --no-git
```

## Supply chain

The build scripts pin exact upstream versions and verify integrity before using anything
downloaded — no moving "latest":

- `scripts/fetch-ffmpeg.sh` — pins an exact `eugeneware/ffmpeg-static` release and
  verifies the binary's **SHA256** (fail-closed on mismatch).
- `scripts/fetch-whisper.sh` — pins the `whisper.cpp` **tag + commit** (verified after
  clone) and the model's **HF revision + SHA256**.
- `.github/workflows/*.yml` — third-party Actions are pinned to a full commit SHA, and
  `gitleaks` is pinned to a fixed version verified by SHA256.

To bump a version, change the pinned constant and re-pin its hash (each script's header
explains how). Don't relax verification to make a build pass.

## Code style

Small, focused files. Immutable patterns (return new objects, do not mutate). Handle
errors explicitly. Match the surrounding style.
