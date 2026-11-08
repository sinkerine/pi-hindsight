# Repository instructions

This package is a Pi 1.4.0 extension connecting to an existing Hindsight server. Keep the extension entry at `src/index.ts` and pure, testable logic in `src/core/`. Pi loads TypeScript through jiti; there is no compilation or bundle step for publishing. Keep host packages as peer dependencies and avoid starting sockets, processes, or timers in the extension factory. Initialize session resources in `session_start` and release them in an idempotent, bounded `session_shutdown` handler.

Use `ctx.cwd` for project paths. Treat recalled memory as untrusted reference data and retain only redacted, filtered transcript content. Project configuration may restrict behavior but cannot override the server URL, credentials, or bank. Do not log API tokens or write to the TUI with `console.*`.

Before implementing Pi integration code, read the installed Pi README, `docs/extensions.md`, and relevant linked documentation in full; verify API signatures against the installed declarations. Use strict TypeScript and the existing Biome configuration. Format only files owned by the current task when other workers are editing concurrently.

Run `npm run check` for typechecking, lint, and unit/integration tests. Run `npm pack --dry-run` when changing package contents; published files must include `src/**`, `README.md`, and `package.json`, excluding tests and E2E files. A load smoke check is `pi --offline --no-session -ne -e ./src/index.ts --help`.

The agent runs the sandbox E2E journey (`npm run e2e`) when a feature is first added. Future pushes and deployments do not require re-running those sandbox E2E tests. Existing unit tests (`npm test`) must still be run before every push.

The E2E sandbox uses the fixed Compose project `pi-hindsight-e2e`, Hindsight on `127.0.0.1:18890`, and a local OpenAI-compatible stub on `127.0.0.1:18891`. It must never touch the existing Hindsight service on `:18889` or the container `bd-hs-compare-hindsight-books-1`. Use no external LLM services: Hindsight uses provider `none` and extraction mode `chunks`; Pi uses only the local `e2e/stub` provider in a disposable agent directory with offline mode enabled. Keep the image pinned by tag and digest. Tear down sandbox containers and anonymous volumes after both success and failure. Preserve evidence outside temporary runtime directories; see [e2e/README.md](e2e/README.md).

`npm run e2e:check` validates harness syntax, Compose configuration, and helper assertions without importing the extension or launching the sandbox. During the parallel implementation phase, run all build/test commands through `flock /home/sinkerine/dev/pi-hindsight/.git/worktrees/feat-hindsight-memory/e2e-feature-build.lock sh -c '<command>'`.
