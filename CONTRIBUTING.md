# Contributing

Thanks for helping improve FunLead Recorder.

## Privacy gate (required)

This repo was extracted from private codebases, so every commit runs a two-layer scan to
guarantee nothing private leaks:

1. **gitleaks** — catches generically secret-shaped tokens (keys, connection strings).
2. **`scripts/secret-scan.sh`** — catches what gitleaks does *not*: customer/identity
   identifiers, internal infrastructure hostnames, internal backend auth symbols, and
   forbidden network calls. This is its differential value; we deliberately do not
   re-implement the generic token patterns that `gitleaks --useDefault` already covers,
   to avoid drift.

The project **brand** ("FunLead", "funlead.app") is intentional and allowed; the gate
never blocks it.

### Install the pre-commit hook

```bash
brew install gitleaks lefthook   # if not already installed
lefthook install
```

Now `git commit` runs the gate locally. To run it manually:

```bash
bun run scan && gitleaks detect --config .gitleaks.toml --no-git
```

## Code style

Small, focused files. Immutable patterns (return new objects, do not mutate). Handle
errors explicitly. Match the surrounding style.
