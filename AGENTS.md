# Development instructions

This repository contains the independent dsh-chatgpt-provider Harness bundle. Read README.md and docs/DEVELOPMENT.md before making changes.

- Integrate through public Harness exports. Do not modify a Harness installation, sibling checkout or another application's credentials.
- Keep official SIWC and experimental Codex connections separate. SIWC uses the public OpenAI API; the Codex compatibility route uses this plugin's own OAuth flow. Never read another client's login cache or fall back to API-key billing.
- Persist credentials only through the host credentials service. Never expose tokens, complete authorization/callback URLs or user prompts in logs, frontend state, tests, documentation or packages.
- Use a separate DSH_HOME for manual verification. A profile alone does not isolate credentials. Real-account probes require an explicit operator action and must not run in CI.
- Treat account identity, cancellation, completed streams and replay as correctness requirements. An interrupted stream must not report success.
- Use pnpm and retain pnpm-lock.yaml as the only dependency lockfile. Run pnpm check, pnpm check:repository and pnpm pack:release for release changes.
- Source lives in src/, automated tests in tests/, optional integration checks in scripts/verify/, and maintained documentation in docs/. Keep machine-specific records and historical working notes under ignored .local/ or .validation/ directories.
- When .codegraph/ exists, use CodeGraph before ordinary code search; otherwise use rg. Do not create an index implicitly.
- Use the codex/ prefix for new work branches. Do not push, rewrite history or publish releases without user authorization.
