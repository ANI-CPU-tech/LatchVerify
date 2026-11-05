# Code cleanup (debloat) progress

A running record of the cleanup that started in v0.2.3, so the next pass can pick up where the
last one stopped. Update the tables when a pass lands.

## Status

| Pass | Release | Scope | Result |
|---|---|---|---|
| 1 | v0.2.3 (`9a24292`) | `src/commands`, `src/daemon`, `src/update`, `web/src/lib`: about 4,600 of 16,700 lines (27%) | 69 lines removed, no behavior change |

Measured at the end of pass 1: 16,686 lines in `src/` and `web/src`, 2,955 of them comment lines
(18%).

### What pass 1 did

- Condensed the six longest doc comments (7 to 25 lines each): `runInit`, `runAdd`, `runProxy`,
  `runReview`, `runSetup` (`src/commands/`) and `syncClients` (`src/daemon/sync.ts`). They walked
  through steps that inline comments below already explain; they now say what the function does,
  its exit codes and `@throws`.
- Fixed a stale comment: `review.ts` said the review UI opens a browser (it has not since the app).
- Un-exported helpers used only in their own file: `describeSync` (`commands/watch.ts`),
  `DEFAULT_DEBOUNCE_MS`, `DEFAULT_POLL_MS`, `DEFAULT_BLOCK_WINDOW_MS` (`daemon/watch.ts`), and
  dropped `setup.ts`'s re-export of `CLIENT_NAMES`.
- Shortened two descriptive blocks in `web/src/lib/desktop.ts` and `web/src/lib/theme.tsx`.

### Still to do in the pass 1 slice

Doc blocks of 4 to 6 lines were left as they are. `src/commands/inspect.ts`, `verify.ts` and
`src/daemon/watch.ts` keep their long blocks: they list exit codes, report formats and watcher
behavior that nothing else documents.

## Remaining, by folder

Lines and comment lines after pass 1. "Risk" is how much a careless cut could cost.

| Folder | Files | Lines | Comment lines | Risk | Notes |
|---|---|---|---|---|---|
| `src/analyze` | 8 | 1,944 | 486 | High | Tier rules and detectors; comments explain why a pattern is tier 3. |
| `src/proxy` | 6 | 1,763 | 439 | High | The security boundary: framing, blocking, first-run pinning. |
| `src/config` | 7 | 1,025 | 324 | High | `clients.ts` cites each client's docs per path; keep the sources. |
| `src/store` | 8 | 1,082 | 274 | High | Integrity records, locks, atomic writes. |
| `src/schema` | 9 | 497 | 134 | Medium | Shared contract; field docs feed the API types. |
| `src/ui` | 5 | 657 | 126 | Medium | Request guard comments must stay (loopback, client header). |
| `src/desktop` | 5 | 644 | 110 | Medium | |
| `web/src/art` | 2 | 689 | 106 | Low | Landscape generator; descriptive comments. |
| `web/src/components` | 12 | 1,475 | 101 | Low | |
| `web/src/pages` | 9 | 1,839 | 62 | Low | Little to cut in comments; look for duplicated JSX instead. |
| `src/dev`, `src/*.ts`, `web/src/*.tsx` | 7 | 519 | 59 | Low | |

Suggested order: pass 2 `web/src/components`, `web/src/pages`, `web/src/art`, `src/desktop`
(low risk, about 4,600 lines); pass 3 `src/ui`, `src/schema`; then the high-risk folders one at
a time, each in its own pass and release.

## Rules (learned in pass 1)

- **Never cut a comment about keys, consent, trust, tampering or security.** Those say why a
  check exists; the code alone cannot. CLAUDE.md's hard rules depend on them.
- **No automatic first-sentence trim.** Pass 1 tried one: it dropped "no notification text is
  ever quoted into a command line" (an injection guard in `daemon/notify.ts`) and the error
  contract of `web/src/lib/api.ts`. Both were reverted. Cut by hand, reading each block.
- Keep exit codes, `@throws`, defaults and report formats.
- Fix stale comments when you find them; a wrong comment is worse than none.
- Behavior never changes in a cleanup pass. Gate each commit on `pnpm typecheck` and `pnpm test`.
- One pass per release, with a changelog line ("Leaner source ... No change in behavior").

## Tools

Comment lines per file (the numbers above):

```sh
python3 - <<'EOF'
import os, re
for root in ["src", "web/src"]:
    for d, _, fs in os.walk(root):
        for f in fs:
            if f.endswith((".ts", ".tsx", ".cts")):
                p = os.path.join(d, f); lines = open(p).read().split("\n")
                c = sum(1 for l in lines if re.match(r"\s*(//|/\*\*?|\*(?!\*)|\*/)", l))
                print(f"{c:4} {len(lines):5} {p}")
EOF
```

Unused exports: `npx -y knip@5 --include exports,types`. Ignore its "unused files" list (it does
not know the app's entry points), and check each export with `grep -rlw <name> src web/src tests
packaging` before un-exporting it: tests and packaging scripts count as users. Candidates it
listed after pass 1, not yet checked: `valueAt`, `PATH_LAUNCH`, `LATCH_ENTRY_ENV`
(`config/clients.ts`), `DEFAULT_CAPTURE_TIMEOUT_MS` (`proxy/capture.ts`),
`DEFAULT_HOLD_TIMEOUT_MS`, `EXIT_GRACE_MS` (`proxy/index.ts`), `MAX_SETTINGS_BYTES`, `ApiError`
(`ui/routes.ts`), `UPDATE_URL`, `PACKAGE_NAMES` (`update/index.ts`). Knip also flags
`appPidPath`, `APP_SCHEME` and `REVIEW_ROUTE`, but `src/desktop/main.ts` uses them: knip misses
that file, so they stay exported.
