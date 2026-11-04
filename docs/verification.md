# Verification scope

- `npm run check`: 11 deterministic tests plus independent browser/Worker type checks and Vite production build.
- `python tests/schema_check.py`: SQLite schema, duplicate lead submissions, atomic quota reservation and retention.
- `uv run --with beautifulsoup4 python tests/ingest_check.py`: table/currency context, exclusions, recommendation removal and missing-selector failure.
- `docs/test-results.md` / `.json`: actual Groq responses to all eight assessment scenarios, including the original question and quoted evidence.
- `docs/production-smoke.json`: deployed API, secret configuration, exact source allowlist, CORS, history/provider validation, consent, idempotent lead writes and a real unknown answer.
- D1 verification confirmed the recorded gap question using its request ID. Synthetic lead records were deleted after the check; audit events were retained.
- Browser verification on the public Pages URL confirmed an actual out-of-scope response, loaded production CSS/CSP, seven source links, working dialogs, own-key settings save/clear behavior, empty local/session storage and a mobile composer without horizontal overflow at 390 × 844. Desktop was also inspected at 1366 × 900.
- An explicit own-key Groq request with a configured model succeeded through the deployed API; credentials were not printed.
- Portuguese cost response was verified through the deployed API. Arabic query translation and Arabic-script output were checked against Groq after correcting language instructions. Spanish fallback strings are implemented but have not received a separate live provider evaluation.
- The refresh workflow was manually run successfully against all seven real pages; the resulting commit was incorporated before final evaluation. The availability workflow completed successfully without a model call.

Not checked: OpenRouter with a real key, sustained load, every language/paraphrase, clinical validity of source claims, or seven elapsed days of uptime. Resources have no seven-day expiry; the operator must keep the account/key active. GitHub Actions and Pages experienced service degradation during initial publication, so workflow status propagation was delayed.
