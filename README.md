# AltCanvas

Self-hosted AI research workspace with native library, file, and canvas
management. AltCanvas authenticates against its own local accounts, stores all
data in SQLite plus content-addressed blob files under `data/`, and reads
research PDFs directly from real filesystem directories configured as native
library roots. External library-server integration was removed in M4; the
archived implementation is preserved on the git tag
`archive/last-altero-compatible`.

## Highlights & Features

- **Spatial Canvas Workspace** — A 2D infinite spatial workspace for synthesizing research notes, cross-document connections, and PDF annotations with fluid panning and cursor-anchored zooming (`Ctrl/Cmd + Wheel`).
- **Full-Text AI Understanding Canvas (🧠 理解全文)** — Extracts PDF text across pages, performs chunked comprehension, and builds an editable structured map (overview, sections, core concepts, key claims & evidence) within an atomic SQLite transaction.
- **Verbatim Evidence Anchoring & Direct Highlighting** — Every AI card carries a verbatim PDF evidence quote. Clicking a quote jumps to the exact page and renders a clean, non-polluting session highlight in the embedded reader using true character-layer geometry.
- **Evidence-to-Annotation Conversion (🔖 证据转批注)** — Convert AI evidence quotes into permanent, formal PDF annotations in your native library (individually or in batch), automatically relinking canvas cards with provenance auditing.
- **Native Library & File Management (M4)** — Browse and manage real disk directories of PDFs, import with SHA-256 content deduplication, rename or move original files safely, and organize documents into single-level research topics without ever duplicating files.
- **Reader-Driven AI Workflow** — Automatic Chinese translation directly written into PDF highlight notes upon creation (`划线后自动中译`), plus one-click card translation and synthesis. An optional server-side translation adapter (M3.1) is loopback-first and SSRF-gated when a remote endpoint is explicitly enabled.
- **Adaptive Card Layout** — Card dimensions dynamically scale to content and quote length in an intelligent grid layout, eliminating unnecessary scrollbars while preserving manual resize and clean vertical stacking.
- **Zero-Trust Security & Encrypted AI Provider** — Local accounts with scrypt-hashed passwords and encrypted HttpOnly session cookies. Personal OpenAI/DeepSeek/Ollama API keys are encrypted at rest on the server (`AES-256-GCM`), isolated per user, never stored in or returned to the browser, and protected by strict anti-SSRF boundaries.
- **Provenance & Portability** — Complete audit trail of canvas node, edge, relink, and AI generation events, with full `.altcanvas.json` bundle export and import.

## Current status

M4 (native file and library management) is in final acceptance (CONDITIONAL PASS pending re-audit and manual verification). AltCanvas runs as a single
Node.js service with local-account authentication, an independent SQLite
Canvas database, content-addressed PDF storage under `data/blobs/`, and
server-configured native library roots (`NATIVE_LIBRARY_ROOTS`) that point at
real directories mounted into the service. PDF loading uses direct HTTP Range
streaming, and annotation round-trips, cross-document source cards, manual
notes, node layout, viewport persistence, typed edges, and the integrated
single-user AI workflow are all validated by automated tests. Multi-user
collaboration is deliberately deferred while the existing workflow goes
through security and interaction stabilization.

## Architecture

- **Single service** (`scripts/dev-server.mjs`) serves the web UI, the static
  reader assets, and the JSON API from one origin.
- **Local accounts** — first-run setup creates the initial administrator;
  sessions are encrypted, HttpOnly, SameSite=Lax cookies signed with
  `SESSION_SECRET`.
- **SQLite Canvas database** (`$DATA_DIR/altcanvas-canvas.sqlite`) stores
  users, documents, attachments, annotations, topics, canvas boards, nodes,
  edges, AI analyses, and provenance events.
- **Content-addressed blob store** (`$DATA_DIR/blobs/sha256/…`) stores
  uploaded PDFs exactly once per distinct SHA-256 with reference counting.
- **Native library roots** — the server scans only administrator-configured
  absolute paths (`NATIVE_LIBRARY_ROOTS`); clients cannot register paths.

## Repository layout

- `vendor/reader` — embedded PDF reader (upstream reader source)
- `vendor/web-library` — upstream web library source
- `docs/m4-native-library-manager.md` — current native library and file manager design
- `docs/canvas-design.md` — Canvas ownership boundary, schema, API, phases, and acceptance baseline
- `docs/handoff.md` — Agent and session continuation log with architecture notes and verified test status
- `docs/human-in-loop-debugging.md` — default human-operated, log-driven UI debugging workflow
- Archived (historical, superseded by the M4 native architecture):
  `docs/altero-auth-bff-design.md`, `docs/topic-research-workspace-design.md`,
  `docs/m0-validation.md`, `docs/m1-api-adaptation.md`

## Development principle

AltCanvas owns its data end to end: local accounts, the SQLite database, the
blob store, and the native library roots. Original PDF files are never
modified except through explicit user actions (rename or move), the extended
name stays `.pdf`, and content deduplication never duplicates files. Canvas,
topic, and AI provenance data live in the AltCanvas database. The
implementation and acceptance baseline is documented in
`docs/canvas-design.md` and `docs/m4-native-library-manager.md`.

## Local development

```sh
node scripts/dev-server.mjs
```

The workspace is then available at `http://localhost:8088`. On an empty
database the UI offers a one-time setup screen to create the initial
administrator account; afterwards all sign-in uses local username and
password.

Run the automated test suites (BFF units, AI provider security, Canvas
persistence and API, UI structure, native M1/M4 loops, translation adapter,
and deployment configuration) with:

```sh
npm test
```

For UI debugging, run `npm run dev`; development-only server and browser logs
are written to the ignored `.debug/` directory. See
`docs/human-in-loop-debugging.md` for the standard human-in-the-loop workflow.

The optional AI workflow can use administrator defaults from `AI_BASE_URL`,
`AI_MODEL`, and `AI_API_KEY`, or a signed-in user's personal OpenAI-compatible
provider entered in Settings. Personal secrets are encrypted at rest in the
per-user Canvas data store and are never returned to or persisted by the browser. Private or HTTP
endpoints such as a local Ollama instance additionally require the administrator
flags `ALLOW_PRIVATE_AI_HOSTS=true` and `ALLOW_INSECURE_AI=true`.
For stronger separation between encrypted AI settings and data backups, set a
high-entropy `AI_SETTINGS_SECRET` outside the data directory. AI requests send
only explicitly selected Canvas card content and source quote snapshots; a
plain-HTTP private-network endpoint exposes that traffic to the local network.

## Production configuration

Copy `.env.example` to `.env` and set at minimum:

```text
NODE_ENV=production
PUBLIC_ORIGIN=https://canvas.example.com
SESSION_SECRET=<at-least-32-random-characters>
```

Key environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8088` | Port to bind the server |
| `HOST` | `0.0.0.0` | Host interface to listen on |
| `PUBLIC_ORIGIN` | `http://localhost:8088` | External public URL of the deployment |
| `SESSION_SECRET` | — | 32+ char key for encrypting cookie sessions across restarts |
| `DATA_DIR` | `./data` | Server-side data directory (sessions, SQLite DB, blobs) |
| `CANVAS_DB_PATH` | `$DATA_DIR/altcanvas-canvas.sqlite` | Independent Canvas SQLite database path |
| `NATIVE_LIBRARY_ROOTS` | — | Semicolon-separated server-side absolute library roots (`path\|name`); must point at mounted directories such as `/app/library` |
| `ALTCANVAS_DATA_DIR` | `./data` | Host directory mounted at `/app/data` by Docker Compose |
| `ALTCANVAS_LIBRARY_DIR` | `./library` | Host directory mounted at `/app/library` by Docker Compose |
| `AI_SETTINGS_SECRET` | — | Optional external secret for AES-256-GCM per-user AI keys |
| `AI_BASE_URL` | — | Server default OpenAI-compatible base URL |
| `AI_MODEL` | — | Server default AI model name |
| `AI_API_KEY` | — | Server default AI API Key (never sent to client) |
| `ALLOW_PRIVATE_AI_HOSTS` | `false` | Set `true` to allow private-network AI hosts (e.g. Ollama) |
| `ALLOW_INSECURE_AI` | `false` | Set `true` to allow non-HTTPS AI endpoints |
| `MAX_CANVAS_BODY_BYTES` | `524288` | Max JSON body size for Canvas API requests |
| `MAX_AI_DOCUMENT_BODY_BYTES`| `786432` | Max upload payload size for whole-document analysis |
| `MAX_AI_DOCUMENT_TEXT_CHARS`| `600000` | Max extractable character count for document understanding |
| `AI_DOCUMENT_CHUNK_CHARS` | `30000` | Character chunk size for parallel document reading |
| `UPSTREAM_STREAM_IDLE_TIMEOUT_MS` | `30000` | Idle timeout for streamed file and AI responses |

Set `TRUST_PROXY=true` only behind a trusted reverse proxy. `PUBLIC_ORIGIN`
must use HTTPS in production.

## Deployment

Builds require compiled Reader and Web Library assets. CI builds both
submodules before constructing the runtime image:

```sh
npm run build:vendor
docker compose build
docker compose up -d
```

`docker-compose.yml` mounts `${ALTCANVAS_DATA_DIR:-./data}` at `/app/data`
(SQLite database, sessions, blob store) and mounts
`${ALTCANVAS_LIBRARY_DIR:-./library}` read-write at `/app/library` as the
default native research library root, exposed to the service through
`NATIVE_LIBRARY_ROOTS=/app/library|研究文库`. Additional library roots can be
configured by mounting more directories and extending `NATIVE_LIBRARY_ROOTS`
with their server-side absolute paths.

After adding or changing Tailwind utility classes, rebuild the checked-in CSS:

```sh
npx --yes tailwindcss@3.4.17 -i styles/input.css -o styles/altcanvas.css --minify --content index.html
```

## Mobile workspace

At widths up to 820px, AltCanvas uses a dedicated single-pane workspace with
bottom navigation for the library, reader, and annotation cards. Selecting a
library item opens the reader automatically. The embedded Reader starts with
its own sidebar closed on mobile to preserve document width; annotation cards
remain available from the bottom navigation.
