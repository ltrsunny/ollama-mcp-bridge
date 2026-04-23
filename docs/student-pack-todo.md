# GitHub Student Pack — enable list

Student Pack activates ~2026-04-26 (3 days from 2026-04-23). Enable **only** the
items below; everything else in the 80+ offer list is personal productivity or
irrelevant to this CLI/MCP project.

## Must enable

### 1. GitHub Pro
- **Why**: unlocks 3000 Actions minutes/month + unlimited private repos.
- **What to do after it activates**: add `.github/workflows/ci.yml` that runs
  `npm ci && npm run build && npm test` on every push + PR. 10-line YAML.
- **Blocks**: none. Purely additive.

### 2. GitHub Codespaces Pro
- **Why**: 180 core-hours/month on clean Linux VMs. Use **once before
  `npm publish`** to verify:
  - install size actually ≤ 50 MB default (scope memo claim)
  - bridge runs on Linux, not just macOS
  - `ollama` as a dependency resolves on a fresh machine
- **Blocks**: npm publish (v0.1.2 or v0.2.0 milestone).

### 3. GitHub Copilot Student
- **Why**: free. Zero incremental value in the Claude Code autonomous workflow,
  but useful when manually editing files in VS Code.
- **What to do**: just click enable. No integration work.

## Optional (only if a specific trigger happens)

| Benefit | Trigger to enable |
|---|---|
| **Codecov** (free public + private) | When we want a coverage badge in README for credibility |
| **Namecheap `.me`** or **Name.com** free domain | When we build a landing page (GitHub Pages free) |
| **POEditor Plus** (1 year) | If README goes bilingual (EN + 中文) |
| **Sentry** (50K errors/year) | v0.2.0 if we add opt-in crash reporting |

## Deliberately skipped

- **Datadog / New Relic** — APM for hosted services; we're a CLI npm package.
- **DigitalOcean $200 / Azure $100 / Heroku $13×24** — no hosting need.
- **BrowserStack / LambdaTest** — we're stdio, not web.
- **Travis CI** — redundant with GitHub Actions.
- **MongoDB $50** — no DB in this project.
- **JetBrains / Tower / GitKraken / Termius** — personal tooling choice.
- **Notion / 1Password / DataCamp / FrontendMasters** — personal productivity.
