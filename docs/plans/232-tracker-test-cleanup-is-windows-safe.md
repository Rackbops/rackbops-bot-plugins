# #232 -- the tracker tests close what they open before removing it, so the suite is green on Windows

Part of Epic #265. Effort S. Tests and test helpers only: no shipped behaviour, no version bump, no
CHANGELOG bullet. Single-auditor lane (one read-only auditor), not the three-reviewer gate.

## Plan (execute as written)

Written 2026-10-11 against `main` at `2949dbe`; re-find each cite by function name.

### What is wrong

On Windows, `bun test plugins/tracker` failed 212 tests at `03f2b76` with `EBUSY: resource busy or
locked, rm '...\Temp\tracker-...'`, although their assertions passed. The cleanup after each test
removes the test's temp directory while the SQLite database, its `-wal` and its `-shm` are still
open. Windows refuses to delete an open file; Linux does not care, so CI (ubuntu) is green. The run
also left 444 `tracker-*` directories under `%TEMP%`.

Four places remove a directory that may still hold an open database:

- `plugins/tracker/src/web/harness.ts` `cleanup()` -- the `afterEach` of every web/API test file.
  `world()` activates a plugin on a file database and returns it; most tests never dispose it.
- `plugins/tracker/src/index.test.ts` -- its own `afterEach` over `dirs`; several tests dispose
  their plugin, many do not.
- `plugins/tracker/src/store.test.ts` -- three `try/finally` blocks ("vacuums an existing
  database once", the one after it, and the file-backed store test); a failed `expect` before the
  `close()` skips the close, and the `finally` then hits EBUSY, hiding the real failure.
- `plugins/tracker/src/digest.test.ts` -- one `try/finally` around a plugin it disposes.

Grep for `rmSync` and `mkdtempSync` under `plugins/tracker` before starting, in case a file was
missed; every hit is in scope.

### Decisions

- **Close first, then remove.** The fix is to release every handle before removing the directory;
  retrying is only a backstop.
  - The harness records each plugin `world()` activates. `cleanup()` becomes `async`: it awaits
    `dispose()` on each recorded plugin (a plugin a test already disposed must tolerate a second
    call; check that `dispose` is idempotent in `index.ts`, and if it is not, record disposal in the
    harness rather than changing `index.ts`), then removes the directories.
  - `index.test.ts` does the same for the plugins its own helpers activate.
  - In `store.test.ts` and `digest.test.ts`, every handle is closed in the `finally` before the
    remove (close is safe to call on an already-closed `Database` in bun:sqlite; verify, and guard
    if it is not).
- **One remove helper, tracker-local and test-only:** `plugins/tracker/src/test-dirs.ts`, imported only
  by test files and the harness (never by `index.ts`, so the bundle never carries it).
  `removeDir(dir, opts?)` calls `rmSync(dir, { recursive: true, force: true })` and on
  `EBUSY`, `EPERM` or `ENOTEMPTY` retries up to 5 times, 100 ms apart (`Bun.sleepSync`). If the last
  try still fails with one of those codes, it does not throw: it writes one line to `console.warn`
  naming the directory and the code, so a leftover temp directory never fails a passing test, and
  the line shows a handle someone forgot to close. Any other error is thrown. The `rmSync` function
  is injectable (`opts.rm`) so the retry is testable on Linux.
  - Do not rely on `rmSync`'s own `maxRetries`: check whether bun 1.4.2 honours it, and record what
    you found in "Deviations as implemented" either way. If it does honour it, still use the helper:
    its warn-instead-of-throw on the last try is the point.
- **No CI job in this PR.** A Windows CI job is the only lasting proof, but it costs CI time on every
  PR and is not a required check; it is the owner's call. The PR says the change is verified on Linux
  only and asks for one `bun test plugins/tracker` run on a Windows machine before merging.

### Steps

1. `plugins/tracker/src/test-dirs.ts`: `removeDir` as decided, with a header comment saying why
   (Windows refuses to delete an open file) and that it is test-only.
2. `plugins/tracker/src/web/harness.ts`: record plugins in `world()`; `cleanup()` async, disposes
   them, then `removeDir` on each directory. Update every `afterEach(cleanup)` caller if the
   signature change needs it (bun's `afterEach` awaits a returned promise; check).
3. `plugins/tracker/src/index.test.ts`: dispose the plugins its helpers activate before `removeDir`.
4. `plugins/tracker/src/store.test.ts`, `plugins/tracker/src/digest.test.ts`: close every handle in
   `finally` before `removeDir`.
5. `plugins/tracker/src/test-dirs.test.ts`:
   - "removes a directory" (real temp dir, gone afterwards).
   - "retries a busy directory and then removes it": an injected `rm` that throws an `EBUSY` error
     twice, then succeeds -> called 3 times, no warning, no throw.
   - "gives up on a directory that stays busy with a warning, not a failure": always `EBUSY` -> called
     6 times, one `console.warn` naming the directory and `EBUSY`, no throw.
   - "throws any other error": an injected `rm` throwing `EACCES` -> throws, called once.
6. `plugins/tracker/src/web/harness.test.ts` (or the nearest existing web test file, if a new file
   would be the only test of the harness): "cleanup disposes every plugin world() made": two worlds,
   `await cleanup()`, then each plugin's database is closed (pick an observable that fails when the
   dispose loop is removed: for example `plugin.health` reporting not running, or a store call on the
   world's database handle throwing; read `index.ts` `dispose` to choose).
7. This file, committed as `docs/plans/232-tracker-test-cleanup-is-windows-safe.md`.
8. Checks: `bun run lint`, `bun run check`, `bun run build`, `bun run generate-index -- --check`,
   `bun run check-contract`, `bun test plugins/tracker`, `bun test`. Paste the counts. Also count
   `tracker-*` directories under `$TMPDIR` (or `/tmp`) before and after `bun test plugins/tracker`;
   after should equal before.
9. Mutations from the table, each in a scratch worktree, never in the tree under test.

### Coverage

| Outcome | Step | Test | Mutation that must fail it |
|---|---|---|---|
| A busy directory is retried, then removed | 1 | "retries a busy directory and then removes it" | drop the retry loop |
| A directory that stays busy warns and does not fail the test | 1 | "gives up on a directory that stays busy ..." | rethrow on the last try |
| Other errors still fail | 1 | "throws any other error" | swallow every error |
| The harness closes what `world()` opened before removing it | 2 | "cleanup disposes every plugin world() made" | drop the dispose loop in `cleanup()` |
| No temp directory is left behind on Linux | 2-4 | the before/after `tracker-*` count in step 8 | -- (a check, not a test) |

Not covered by any test here, and said so in the PR: that the change makes the Windows run green.
Only a Windows run shows that.

## Deviations as implemented

1. **bun 1.4.2's `rmSync` ignores `maxRetries`.** Checked against a real `EBUSY` (a tmpfs mounted
   inside the directory, which Linux refuses to remove): `rmSync(dir, { recursive: true, force:
   true, maxRetries: 3, retryDelay: 300 })` threw `EBUSY` after 1-2 ms, and `strace` showed one
   `unlinkat(..., AT_REMOVEDIR) = -1 EBUSY` and no sleep. So `removeDir`'s own loop is what retries,
   as decided; its header comment says so.
2. **`index.test.ts` has no helper that activates a plugin, and what it left open was not its
   plugins.** Each test makes its own plugin, and every one was already disposed when the test
   passes; what stayed open were the second connections (`store`, `reopened`: five `openDatabase`
   handles never closed, even in a passing test). So instead of "dispose the plugins its helpers
   activate", `closeAfter()` notes every plugin and database a test opens on a temp file, and the
   `afterEach` disposes or closes each, then calls `removeDir`. The tests' own `dispose()` and
   `close()` calls stay (several are what the test checks); a second one does nothing.
3. **`store.test.ts` and `digest.test.ts` also left a handle open when they pass, not only after a
   failed `expect`.** The file-backed store test never closed its reopened connection (`again`), and
   the digest test never closed its second connection (`store`). Both are now closed in the
   `finally` with the rest. In `store.test.ts` a local `opened()` (`keep`, `close`) notes them, and
   the vacuum test became `async` to await it; in `digest.test.ts` the plugin is made before the
   `try`, so the `finally` can dispose it.
4. **`execute-lane.test.ts`, not in the plan, had to change.** Two tests ("never holds up the notify
   lane ..." and "a queue turn about a task the execute tick holds answers busy at once ...") leave
   a city-hall call unanswered forever, so an execute run is still in flight at cleanup, and
   `index.ts` `dispose()` waits up to 5 s for it -- as long as bun's default hook timeout. Once
   `cleanup()` awaited `dispose()`, the second test failed when run alone ("a beforeEach/afterEach
   hook timed out"), and the two added about 10 s to the suite. Their fake is now `silentCityHall()`:
   it still never answers while the test runs, and its `hangUp()`, called after the test's last
   assertion, fails every call still out and every later one; the test then awaits the run, so
   `dispose()` has nothing to wait for. Later calls fail too because in the second test the run had
   not yet called city-hall by its last assertion.
5. **`scout.test.ts` calls `cleanup()` in a test body** ("is offered on the web only while the model
   runner is set up"), not only as an `afterEach`, so the signature change did need a caller
   updated: it now awaits it. Unawaited, the async `cleanup()` went on after the test's next
   `world()` had pushed its directory, and removed that directory under the second plugin's open
   database (on `main` the same call removed the first plugin's directory while it was still open).
   Found on Linux by listing `/proc/self/fd` inside `removeDir` before each removal, over a full
   `bun test plugins/tracker`: this was the one directory removed with a file in it still open. So
   that a forgotten `await` cannot do this again, `cleanup()` also takes the plugins and directories
   made before the call, and leaves any made while it awaits for the next call.
