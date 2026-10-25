# AL-FS-01 — AI-Powered Contextual Test Case Generation from BRD

> **Candidate:** Charla Kousthub Raghavendra | **Role:** Full Stack Developer | **Assessment:** AL-FS-01

---

## Overview

An AI-powered full-stack system that:

1. **Parses BRD documents** (PDF / DOCX / TXT) and extracts structured requirements using an LLM
2. **Crawls a live web application** using Playwright — per user role — and captures every screen, form field, button, and workflow
3. **Builds an Application Knowledge Model** (page inventory, element map, workflow graph, role-permission matrix)
4. **Maps requirements to application features** with bidirectional gap reporting
5. **Generates contextual test cases** using real UI labels — positive, negative, boundary, field-validation, role-access, e2e, business-rule
6. **Exports** Requirement Traceability Matrix (RTM) + gap report to Excel, CSV, and JSON

All through a premium dark-mode web UI.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Browser (Frontend SPA)              │
│  public/index.html · public/css/ · public/js/   │
└───────────────────┬─────────────────────────────┘
                    │ REST API
┌───────────────────▼─────────────────────────────┐
│          Express Server  (server.js)             │
│                                                  │
│  ┌─────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ A. BRD  │  │ B. Crawl │  │ C. Knowledge  │  │
│  │ Parser  │  │ (Playwright)│ │    Model     │  │
│  └────┬────┘  └─────┬────┘  └──────┬────────┘  │
│       │             │              │            │
│  ┌────▼─────────────▼──────────────▼────────┐  │
│  │       LLM Service (OpenAI / Azure)        │  │
│  └────────────────────┬──────────────────────┘  │
│                       │                         │
│  ┌────────────────────▼──────────────────────┐  │
│  │  D. Requirement Mapper                    │  │
│  ├───────────────────────────────────────────┤  │
│  │  E. Test Case Generator                   │  │
│  ├───────────────────────────────────────────┤  │
│  │  F. Export Manager (Excel / CSV / JSON)   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
         │                          │
   data/knowledge/            output/
   (JSON model cache)        (Excel, CSV, JSON)
```

**Key data flow:**
```
BRD file → parse → requirements[]
   + crawl results → knowledge model → LLM mapping
                                      → LLM test generation
                                      → RTM + exports
```

---

## Setup & Configuration

### Prerequisites
- Node.js ≥ 18
- An OpenAI API key (or Azure OpenAI credentials)

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd al-fs-01-brd-test-generator
npm install
npm run install:browsers   # installs Playwright's Chromium browser
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI API key |
| `OPENAI_MODEL` | e.g. `gpt-4o` (default) |
| `APP_URL` | The staging application URL to crawl |
| `ROLE_ADMIN_USERNAME` / `ROLE_ADMIN_PASSWORD` | Admin credentials |
| `ROLE_MANAGER_USERNAME` / `ROLE_MANAGER_PASSWORD` | Manager credentials |
| `CRAWL_MAX_DEPTH` | How deep to crawl (default: 5) |
| `CRAWL_MAX_PAGES` | Max pages per role (default: 100) |

> ⚠️ **NEVER** commit your `.env` file or put real credentials in code.

### 3. Run the Server

```bash
npm run dev        # development mode (auto-restart)
# OR
npm start          # production
```

Open **http://localhost:3000** in your browser.

---

## How to Use

### Option A — Web UI (Step-by-Step)

1. **BRD Upload** tab → drag-and-drop your BRD file (PDF/DOCX/TXT)
2. **App Crawler** tab → enter URL, add role credentials, click "Start Crawling"
3. **Requirements** tab → click "Run Requirement Mapping"
4. **Test Cases** tab → click "Generate Test Cases", then review/approve per case
5. **RTM & Gaps** tab → view traceability matrix
6. **Export** tab → download Excel, CSV, or JSON

### Option B — Full Pipeline (Dashboard)

1. Upload BRD on the BRD Upload tab first
2. Go to Dashboard and click **"Run Full Pipeline"**

### Option C — REST API

```bash
# Parse BRD
curl -F "brd=@requirements.pdf" http://localhost:3000/api/brd/upload

# Start crawl (with roles in JSON body)
curl -X POST http://localhost:3000/api/crawl/start \
  -H "Content-Type: application/json" \
  -d '{"appUrl":"https://app.example.com","roles":{"admin":{"username":"u","password":"p"}}}'

# Build knowledge model
curl -X POST http://localhost:3000/api/model/build

# Map requirements
curl -X POST http://localhost:3000/api/mapping/run

# Generate test cases
curl -X POST http://localhost:3000/api/testcases/generate

# Export Excel
curl -X POST http://localhost:3000/api/export/excel -o test-output.xlsx
```

---

## How to Run Tests

```bash
npm test
```

Tests use Node.js built-in `node:test` — no extra test framework needed.

---

## Assumptions

1. **Login form detection** — the crawler looks for common input patterns (`name="username"`, `type="email"`, etc.). For highly custom login forms, selectors may need extending in `src/modules/appCrawler.js`.
2. **OTP/MFA/CAPTCHA** — if detected, the system logs the challenge and skips that role (manual intervention required). Automated CAPTCHA bypass is deliberately excluded.
3. **LLM model** — GPT-4o is the default. For private/local LLM, set `LLM_PROVIDER=local` and configure a compatible OpenAI-API endpoint.
4. **Knowledge model reuse** — the model is saved to `data/knowledge/knowledge-model.json` and can be loaded on subsequent runs without re-crawling.
5. **BRD without explicit IDs** — the system auto-assigns IDs (REQ-001, REQ-002 …) via sequential numbering after deduplication.
6. **"Destructive action" safety** — URLs and button texts matching any of: `logout, delete, remove, payment, destroy, checkout` are automatically skipped during crawling.

---

## Known Limitations

- **Login challenges** — OTP / CAPTCHA / SSO require manual intervention; the system logs and skips.
- **Very large BRDs** — documents over ~50 000 words are chunked; cross-chunk deduplication may miss some requirements.
- **Dynamic SPAs** — crawling relies on `networkidle`; apps using WebSockets or custom routing may need additional Playwright hooks.
- **Token costs** — large apps + many requirements can use 50 000+ tokens per run. Monitor via the live cost tracker in the UI.
- **Excel export** — requires `exceljs`; very large datasets (>5 000 test cases) may take 10–30 seconds.
- **No Jira/TestRail integration yet** — the JSON output is compatible with these tools' import formats.

---

## Project Structure

```
.
├── config/
│   └── default.js          ← Central config (all knobs)
├── data/
│   └── knowledge/          ← Saved knowledge models (git-ignored)
├── logs/                   ← Application logs (git-ignored)
├── output/                 ← Generated exports (git-ignored)
├── public/
│   ├── index.html          ← Single-page web UI
│   ├── css/styles.css      ← Premium dark-mode design system
│   └── js/app.js           ← Frontend JS
├── samples/
│   ├── sample_brd_parse_output.json
│   ├── sample_test_cases.json
│   └── sample_rtm_and_gap_report.json
├── src/
│   ├── modules/
│   │   ├── brdParser.js            ← A. BRD Understanding
│   │   ├── appCrawler.js           ← B. Application Exploration
│   │   ├── knowledgeModel.js       ← C. Knowledge Model
│   │   ├── requirementMapper.js    ← D. Requirement Mapping
│   │   ├── testCaseGenerator.js    ← E. Test Case Generation
│   │   └── exportManager.js        ← F. Traceability & Output
│   ├── routes/
│   │   └── api.js                  ← REST API endpoints
│   └── services/
│       ├── llmService.js           ← LLM gateway (cost tracking)
│       └── logger.js               ← Winston structured logging
├── tests/
│   ├── brdParser.test.js
│   ├── knowledgeModel.test.js
│   └── exportManager.test.js
├── .env.example            ← All settings documented, no real values
├── .gitignore
├── package.json
└── server.js               ← Express entry point
```

---

## Security Notes

- Credentials are read from `.env` — **never sent to the LLM**
- No credentials stored in code or logs
- The `.env` file is in `.gitignore`
- BRD text is sent to the LLM; ensure your LLM provider's data handling meets your confidentiality requirements
- For fully private processing, set `LLM_PROVIDER=local` and point to a self-hosted model

---

*AudicLabs India — AL-FS-01 | Charla Kousthub Raghavendra*
