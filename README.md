# AltCanvas

Self-hosted AI research workspace with native library, file, and canvas
management. AltCanvas authenticates against its own local accounts, stores all
data in SQLite plus content-addressed blob files under `data/`, and reads
research PDFs directly from real filesystem directories configured as native
library roots. External library-server integration was removed in M4; the
archived implementation is preserved on the git tag
`archive/last-altero-compatible`.

## Highlights & Features

- **Structured reading guide (v0.4.7)** — The right pane follows the opened article, leads with its conclusions, then explains their meaning, supporting arguments, necessary concepts and limits in continuous readable paragraphs. Evidence links locate and temporarily highlight the original text. Annotations have their own tab; the existing canvas remains available through the advanced view. Full reading does not automatically compare unrelated articles. Old analyses render without migration; reanalysis adds the versioned structured fields.

- **Reading workflow (v0.3)** — PDF, TXT and EPUB can enter the same native library. TXT/EPUB use a safe plain-text chapter view with persistent annotations and text-block navigation. Metadata recognition uses the opening pages; classification reuses existing topics and supports multiple topics per document. Necessary new topics require an explanation and a matching document.
- **Trustworthy document coverage** — Full-document mapping reads beyond 40 pages, rejects documents over the analysis budget explicitly, and marks unmatched quotes as awaiting verification. Reanalysis bypasses the versioned AI cache while preserving manually edited source cards. The CPA connection settings stay unchanged.

- **Spatial Canvas Workspace** — A 2D infinite spatial workspace for synthesizing research notes, cross-document connections, and PDF annotations with fluid panning and cursor-anchored zooming (`Ctrl/Cmd + Wheel`).
- **Full-Text AI Understanding Canvas (🧠 理解全文)** — Extracts PDF text across pages, performs chunked comprehension, and builds an editable structured map (overview, sections, core concepts, key claims & evidence) within an atomic SQLite transaction.
- **Verbatim Evidence Anchoring & Direct Highlighting** — Matched quotes navigate to their source. Unmatched quotations remain unverified and cannot be converted into annotations; the system never replaces them with an unrelated sentence to manufacture evidence.
- **Evidence-to-Annotation Conversion (🔖 证据转批注)** — Convert AI evidence quotes into permanent, formal PDF annotations in your native library (individually or in batch), automatically relinking canvas cards with provenance auditing.
- **Native Library & File Management (M4)** — Browse and manage real disk directories of PDFs, import with SHA-256 content deduplication, rename or move original files safely, and organize documents into single-level research topics without ever duplicating files.
- **Reader-Driven AI Workflow** — Automatic Chinese translation directly written into PDF highlight notes upon creation (`划线后自动中译`), plus one-click card translation and synthesis. An optional server-side translation adapter (M3.1) is loopback-first and SSRF-gated when a remote endpoint is explicitly enabled.
- **Adaptive Card Layout** — Card dimensions dynamically scale to content and quote length in an intelligent grid layout, eliminating unnecessary scrollbars while preserving manual resize and clean vertical stacking.
- **Zero-Trust Security & Encrypted AI Provider** — Local accounts with scrypt-hashed passwords and encrypted HttpOnly session cookies. Personal OpenAI/DeepSeek/Ollama API keys are encrypted at rest on the server (`AES-256-GCM`), isolated per user, never stored in or returned to the browser, and protected by strict anti-SSRF boundaries.
- **Provenance & Portability** — Complete audit trail of canvas node, edge, relink, and AI generation events, with full `.altcanvas.json` bundle export and import.

## Current status

The deployed release is v0.4.7, with automated coverage for the native library, file management and reading guide. UI acceptance follows the human-operated workflow in `docs/human-in-loop-debugging.md`; automated checks do not replace that acceptance. AltCanvas runs as a single
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
npm ci
node scripts/dev-server.mjs
```

PDF reading requires the compiled `vendor/reader/build/web` distribution. TXT/EPUB do not execute embedded HTML or external resources; they use text-block numbers rather than printed book pages. Scanned PDFs require OCR before text-based AI analysis. Full analysis currently accepts up to 500 pages/blocks and 600,000 characters, also subject to the request-byte budget.

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
high-entropy `AI_SETTINGS_SECRET` outside the data directory. Depending on the requested action, AI requests send opening-page text for metadata recognition, full extracted article text for reading guides, or selected Canvas content and source quotes; a
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

The current production deployment runs the source directly on 192.168.5.237,
in `/home/sadgen/Projects/AltCanvas`, managed by the user systemd service
`altcanvas.service`. GitHub Actions runs tests for master pushes and pull
requests; it does not build or publish images or deploy the service.

Before updating production, keep a rollback commit and back up the live
SQLite database with SQLite's online backup mechanism, its encryption key,
and private configuration. Update the checkout to the reviewed commit, then:

```sh
npm ci --omit=dev
npm test
systemctl --user restart altcanvas.service
systemctl --user is-active altcanvas.service
```

Keep the existing `.env`, data directory, native library mounts and compiled
Reader assets. Verify the homepage, reader and logs after restart. A fresh
checkout requires the vendor submodules and compiled distributions; use
`npm run build:vendor` when those assets need building. Test CI exercises the
backend and UI behavior tests without building the vendor distributions.

`Dockerfile` and `docker-compose.yml` are retained as optional configuration
for future container deployment. They are not used by the current production
service, and no image publication is configured.

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
