# Airport Investment Intelligence Agent

A chat agent that helps analysts screen US airports for modernization and expansion. You ask in plain language; the agent calls deterministic analytics over public BTS and FAA data and explains the result. Rankings, comparisons and every figure in the tables and charts are computed by code. The language model chooses which analysis to run and writes the explanation; it is instructed to quote tool results rather than calculate, and its prose is checked against them (see Known limitations).

**Live demo:** https://web-production-0e7b38d4.up.railway.app (Railway; the Gemini key is held only by the backend service).

Built for the take-home in [`assignment.md`](assignment.md). The design is described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What it does

| Assignment question | How it is answered |
|---|---|
| Which New England airports are strong expansion candidates? | `rank_expansion_opportunities`: a percentile-based opportunity score with a per-metric breakdown |
| Compare LA and Santa Ana congestion | `compare_operations`: delay, cancellation and taxi-out rates with a "no clear difference" verdict where the gap is within noise; asks which "LA" airport you mean |
| What percentage of flights out of Anchorage are long haul? | `get_long_haul_share`: share at a stated threshold (3,000 miles by default) plus sensitivity at other thresholds |
| What is the unmet demand at SFO, and why? | Explains that unmet demand cannot be measured with the datasets used, then shows demand-pressure indicators against peer airports |

The agent also supports follow-ups ("same for Florida", "double the weight on growth"), shows its assumptions, data periods and limits with each answer, and has optional voice input in browsers that support speech recognition.

## Technology

- **Backend:** Node.js, TypeScript, Express 5, Zod, LangChain (`createAgent`) with Google Gemini (`@langchain/google-genai`). Gemini is an engineering choice (free tier, tool calling); the assignment does not require a particular model.
- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Radix primitives, Recharts. Light and dark themes.
- **Tests:** Vitest (373 server tests, 27 web tests).
- **Packaging:** Docker Compose (two containers).

## Prerequisites

- Node.js 22.22.2 or newer in the 22 line, or 24.15 or newer (developed on Node 24). This is the range required by the test tooling (Vitest 5 and jsdom 31); the same range is in `package.json` `engines`. The Docker images use `node:22-alpine`, which satisfies it.
- A Gemini API key from <https://aistudio.google.com/apikey>. A free-tier key can run the app, but quotas vary by account and model, so it may be rate limited or exhausted.
- Docker with Compose, only for the Docker route.
- Internet access at runtime: passenger totals are queried live from BTS, and current FAA disruptions are live. Without a key the API still starts and the data endpoints work, but chat is disabled.

## Configuration

Copy the template and add your key. `.env` is git-ignored and is read by the server only.

```bash
cp .env.example .env      # then set GEMINI_API_KEY
```

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | none | Required for chat. Never sent to the browser. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Primary model; must support tool calling. |
| `GEMINI_FALLBACK_MODEL` | none (see `.env.example`) | Tried in order when the primary fails or is out of quota. Comma-separate for several. The deployed instance uses `gemini-3.1-flash-lite-preview,gemini-3-flash-preview,gemini-3.1-flash-lite`. Each model has its own daily budget. |
| `MODEL_RPM` | `12` | Client-side cap on requests per minute per model, retries included. Set it at or below your key's per-minute limit for that model (the free tier has typically been about 15, but limits vary by account and model). It does not track daily or token quotas; those are enforced by Google and surface as errors. |
| `PORT` | `3001` | Express port. |
| `REQUEST_TIMEOUT_MS` | `90000` | Deadline for one user message, including retries and tools. |
| `AGENT_MAX_STEPS`, `AGENT_MAX_TOOL_CALLS` | `8`, `12` | Per-message limits on model calls and tool calls. |
| `MODEL_MAX_RETRIES`, `MODEL_RETRY_INITIAL_MS`, `MODEL_RETRY_MAX_MS` | `2`, `1000`, `8000` | Retry policy for transient model errors. |
| `HISTORY_MAX_TURNS`, `HISTORY_MAX_CHARS`, `SESSION_TTL_MS`, `MAX_SESSIONS` | `8`, `24000`, `3600000`, `200` | In-memory conversation bounds. |
| `MAX_CONCURRENT_TURNS` | `4` | More simultaneous questions get HTTP 429. |
| `GROUNDING_CORRECTION` | `true` | Allow one extra model call to fix unsupported figures. |
| `USE_LIVE_TRAFFIC` | `true` | `false` = use only the bundled snapshot (offline). |
| `BACKEND_URL` (web, build time) | `http://localhost:3001` | Where Next.js proxies `/api`. Docker sets it to `http://server:3001`. |

## Run locally (no Docker)

```bash
npm ci                      # installs both workspaces (server, web) from the lockfile
cp .env.example .env        # set GEMINI_API_KEY
npm run dev                 # API on :3001 and UI on :3000
```

Open <http://localhost:3000>. The browser only talks to port 3000; Next.js proxies `/api/*` to Express.

Production-style run without Docker:

```bash
npm run build
npm start                              # API on :3001 (serves dist/)
npm run start -w web                   # UI on :3000, in a second terminal
```

Check which configured models answer (one small request each): `npm run check:models`.

## Run with Docker Compose

```bash
cp .env.example .env        # set GEMINI_API_KEY
docker compose up --build
```

Open <http://localhost:3000>. Only port 3000 is published; the API is reachable from the web container over the Compose network. The key is passed to the `server` container only. Both containers have health checks, and `web` starts after `server` is healthy.

The images contain the committed processed datasets (`data/processed`, about 3 MB). Nothing is downloaded or rebuilt at startup.

## Tests and checks

```bash
npm test             # server (Vitest) then web (Vitest + Testing Library)
npm run typecheck    # both workspaces
npm run build        # server (tsc) and web (next build)
npm run eval:agent   # live evaluation against Gemini; spends real quota
```

The tests use a scripted fake model and mocked HTTP, so they need no key and no network. Two commands call the real model: `npm run check:models` (one small request per configured model) and `npm run eval:agent` (dozens of requests plus live data fetches). The last evaluation output is in [`docs/e2e/agent-eval.md`](docs/e2e/agent-eval.md).

## Example questions

- Which airports in New England are strong candidates for terminal expansion?
- Compare LAX and Santa Ana airport congestion levels.
- What percentage of flights out of Anchorage are long haul?
- What is the unmet flight demand at SFO, and why?
- Rank airports in Texas for expansion, then compare the top three. (follow-up: "weight growth more heavily")
- Among airports with more than 5 million passengers, which have the highest share of international departures?
- Which airports within 150 miles of Chicago have more than 2 million passengers, and which has the longest runway?

## Data sources

The assignment asks for public APIs. Some of the data comes from true APIs and some from public bulk downloads, and the two are kept separate:

| Data | Source | Access | When fetched |
|---|---|---|---|
| Monthly passengers, seats, departures (36 months) | BTS T-100 Segment Summary by Origin Airport, data.bts.gov (Socrata, `r495-tyji`) | **Public API** | Live per question (6 h cache); bundled snapshot only if the API fails, and the result says so |
| Current airport disruptions | FAA NAS Status (XML) | **Public API** | Live (60 s cache); current conditions only, never historical |
| Airport coordinates and runways | FAA NTAD Aviation Facilities and Runways (ArcGIS REST) | **Public API** | At data-build time; stored in `airports.json` (FAA data effective date is shown in the app) |
| Routes, distances, service class (long haul) | BTS T-100 Segment (All Carriers) | **Public download** (TranStats form, ZIP/CSV; no API) | Prefetched for June to August 2026, committed as aggregates |
| Delays, cancellations, taxi-out | BTS Reporting Carrier On-Time Performance | **Public download** (TranStats form, ZIP/CSV; no API) | Prefetched for June to August 2026, committed as aggregates |

The downloaded tables are about 35 MB per month, so they are aggregated once into small files in `data/processed/` and the raw archives are not kept. Aggregates store counts, sums and taxi-out histograms, never rates, so months combine exactly. The operational metrics therefore cover only June to August 2026 (the "aligned months"); this is stated in the app.

Refresh (optional; about 15 minutes, needs network; raw files are git-ignored and can be deleted afterwards):

```bash
npm run data:download -- segment 2026-06 2026-07 2026-08
npm run data:download -- ontime  2026-06 2026-07 2026-08
npm run data:build   -- --months 2026-06,2026-07,2026-08
npm run data:verify
```

See [`data/README.md`](data/README.md) for the files.

## Verification status

What was run, and what was not:

- **Passed:** all server and web tests, typecheck, and production builds; the live agent evaluation (77 of 78 checks; the miss is the "Southeast" scenario, see limitations).
- **Passed in a clean copy outside the repository tree (no reference to earlier code):** `docker compose build` and `up`; both containers healthy; the web page and `/api/meta` (data periods and datasets) returned 200 through the web container; the processed datasets present in the image; the web container has no Gemini variable; an SSE request through the web container delivered progress events as they happened and the API's timeout error event.
- **Passed outside Docker (local `next start` plus Express):** two real Gemini questions (a Massachusetts ranking and LAX vs Santa Ana) streamed through the Next.js proxy and rendered in a headless browser, in light and dark themes, at desktop and phone widths. Conversational follow-ups were exercised by the live evaluation at the agent level (several scenarios), but were not clicked through in the Next.js UI.
- **Passed on Railway (public URL, 2026-11-26):** the New England ranking question, a conversational follow-up in the same session, and a repeat of the question, all through the public web service and its private-network proxy to the backend. Progress events arrived incrementally, each turn called `rank_expansion_opportunities` once, grounding was `verified`, and the payload carried the ranked rows with per-metric contributions, correlation diagnostics and rank stability. Earlier the same day the first attempt failed; see the incident below.
- **Not re-checked in a production browser:** the rendered tables and charts on the public URL (the browser tool was unavailable). Rendering was verified earlier in a headless browser against a local build and is covered by the web tests.

### Incident: "The AI model is busy" (2026-11-26)

- **Root cause:** the free-tier daily quota of the primary model (`gemini-3.5-flash-lite`, 500 requests per day per project and model, `GenerateRequestsPerDayPerProjectPerModel-FreeTier`) was used up, mostly by development and evaluation runs. The single fallback model was returning 503 ("high demand"), so both failed. The quota resets at midnight Pacific time; after the reset the primary served requests normally.
- **Application defect found:** the daily-quota detail is in the structured error (`errorDetails`), not the message text, so the app classified the 429 as transient and retried it before failing over. This wasted time and request slots. It is fixed: a daily quota now fails over immediately.
- **Changes:** the daily quota is detected from the error details (with a regression test using the real error shape); a fallback chain of three models replaces the single fallback; failed model calls are now logged as status and quota id.
- **Remaining risk:** the free tier can still be exhausted or overloaded at any time. With the primary out of quota, the new chain answered a question in under 4 seconds on the first fallback. A paid key or a higher quota tier is the real remedy for sustained use.

## Known limitations

- **Free-tier model.** Gemini can be slow, overloaded or out of quota. The app retries transient errors with backoff, caps requests at 12 per minute per model (this limits request rate only, not daily or token quotas), switches to the fallback model, and otherwise returns a typed error. In the worst case (both models down) a question waits for the 90 s turn limit before failing.
- **Operational data window.** Delays, cancellations, taxi-out and routes cover June to August 2026 and only airlines that report to BTS. Coverage per airport is shown; below 50% the figures are flagged and excluded from ranking.
- **Opportunity score is a screening indicator.** It is percentile-based and relative to the airports in the candidate set, with judgemental weights. It is not profitability, a forecast, or evidence that a terminal is constrained. No terminal, gate, financial or regulatory data is used.
- **Unmet demand cannot be measured** with the datasets used here (no booking, fare, waitlist or capacity-denial data). The app reports capacity-pressure indicators, not causes.
- **"Long haul" has no standard definition.** 3,000 miles and service class F (scheduled passenger/cargo) are assumptions. Sensitivity to the threshold and to the class definition is shown, each with its own denominator; at cargo hubs the class choice matters a lot (for Anchorage, summer 2026: about 4.6% for class F against about 25% across all classes).
- **Departure counts include all service classes.** The API's departure totals include all-cargo and non-scheduled flights. Departures per runway therefore reflect total airfield use, and at cargo hubs (Memphis, Anchorage) overstate passenger-related pressure; seats per departure is understated there. Passenger counts, seats and load factor are unaffected.
- **Answer checks are heuristics.** The grounding check reduces invented figures but does not eliminate them: it confirms that numbers and years in the prose appear in the tool results; it cannot tell whether a number is attached to the right airport and cannot verify wording or causes. The wording check covers a short list of strong phrases. The argument policy is wording-based and can misjudge intent; it tells the user what it did. Tables and charts, rendered from tool output, are the authoritative values.
- **Informal places.** "Southeast" is interpreted by the model; in testing it chose the Census "South Atlantic" division, which omits several southeastern states. The states used are listed in the answer and flagged, but the interpretation can still differ from what you meant.
- **State is in memory.** Conversations are kept in the server process (bounded, one hour); a restart clears them. There is no authentication, so it is meant for a trusted network.
- **Voice input** uses the browser's speech recognition (Chrome and Edge); the audio may be processed by the browser vendor's service.
- **Docker proxy target** is fixed at build time (`BACKEND_URL`); changing it means rebuilding the web image.

## Repository layout

```
server/            Express API, analytics, tools, agent (TypeScript)
  src/data/          API clients, aggregation, data store loader
  src/analytics/     scoring, screening, operations, routes, demand pressure
  src/tools/         tool specs, argument policy, response envelope
  src/agent/         LangChain agent, conversation, grounding, retries, rate limiter
  scripts/           data download/build/verify, live evaluation, model check
web/               Next.js UI (app, components/{chat,analytics,ui}, hooks, services)
data/processed/    committed aggregates the app runs on
docs/              ARCHITECTURE.md and the live evaluation report
```
