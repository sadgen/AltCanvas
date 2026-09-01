# AltCanvas

Self-hosted AI research workspace built on Zotero-compatible infrastructure.

## Highlights & Features

- **Spatial Canvas Workspace** — A 2D infinite spatial workspace for synthesizing research notes, cross-document connections, and PDF annotations with fluid panning and cursor-anchored zooming (`Ctrl/Cmd + Wheel`).
- **Full-Text AI Understanding Canvas (🧠 理解全文)** — Extracts PDF text across pages, performs chunked comprehension, and builds an editable structured map (overview, sections, core concepts, key claims & evidence) within an atomic SQLite transaction.
- **Verbatim Evidence Anchoring & Direct Highlighting** — Every AI card carries a verbatim PDF evidence quote. Clicking a quote jumps to the exact page and renders a clean, non-polluting session highlight in the Zotero Reader using true character-layer geometry.
- **Evidence-to-Annotation Conversion (🔖 证据转批注)** — Convert AI evidence quotes into permanent, formal PDF annotations in your Zotero/Altero library (individually or in batch), automatically relinking canvas cards with provenance auditing.
- **Reader-Driven AI Workflow** — Automatic Chinese translation directly written into PDF highlight notes upon creation (`划线后自动中译`), plus one-click card translation and synthesis.
- **Adaptive Card Layout** — Card dimensions dynamically scale to content and quote length in an intelligent grid layout, eliminating unnecessary scrollbars while preserving manual resize and clean vertical stacking.
- **Zero-Trust Security & Encrypted AI Provider** — Personal OpenAI/DeepSeek/Ollama API keys are encrypted at rest on the server (`AES-256-GCM`), isolated per user, never stored in or returned to the browser, and protected by strict anti-SSRF boundaries.
- **BFF Architecture & OIDC Authentication** — Same-origin Backend-for-Frontend with OAuth 2.0 Authorization Code + PKCE, ID Token signature validation, rotating refresh tokens, and direct HTTP Range streaming for large PDFs.
- **Provenance & Portability** — Complete audit trail of canvas node, edge, relink, and AI generation events, with full `.altcanvas.json` bundle export and import.

## Current status

M0 is complete: Zotero desktop synchronization, Zotero-compatible API reads,
PDF/Range loading, and annotation round-trips have been validated against a
dedicated Altero test library.

AltCanvas now includes a same-origin BFF with OAuth 2.0 Authorization Code +
PKCE, OIDC discovery/JWKS/ID Token validation, encrypted server-side sessions,
API/file proxies, an embedded Zotero Reader workspace, and a persistent spatial Canvas.
Canvas supports cross-document source cards, manual notes, node layout,
viewport persistence, typed edges, and an integrated single-user AI workflow.
Multi-user collaboration is deliberately deferred while the existing single-user
workflow goes through security and interaction stabilization.

## Repository layout

- `vendor/web-library` — upstream Zotero Web Library source
- `vendor/reader` — upstream Zotero Reader source
- `docs/m0-validation.md` — integration checkpoints and test matrix
- `docs/m1-api-adaptation.md` — Web Library endpoint, auth, CORS, and file contract
- `docs/altero-auth-bff-design.md` — production login, OAuth/OIDC, BFF, token, and privacy design
- `docs/canvas-design.md` — Canvas ownership boundary, schema, API, phases, and acceptance baseline
- `docs/topic-research-workspace-design.md` — topic inbox, Collection sync, multi-report AI knowledge graph, Canvas-first PDF UX, and staged implementation plan
- `docs/handoff.md` — Agent and session continuation log with architecture notes and verified test status
- `docs/human-in-loop-debugging.md` — default human-operated, log-driven UI debugging workflow
- `config/altero.web-library.example.json` — runtime-injected Web Library configuration
- `scripts/probe-altero.mjs` — credential-free-in-repo API compatibility probe

## Development principle

AltCanvas must use Zotero-compatible data for items, attachments, notes, and
annotations. Canvas, workspace, and AI provenance data live in a separate
AltCanvas service and database. Do not modify the altero database schema. The
implementation and acceptance baseline is documented in
`docs/canvas-design.md`.

## Next milestone

Complete production validation against an Altero node that implements the OIDC
contract, then integrate the upstream Web Library. The current main workspace
uses a purpose-built library navigator; `/web-library/` only exposes the built
upstream assets and is not yet the primary UI.

The first part of this work is documented in
`docs/m1-api-adaptation.md`. It uses Web Library's existing
`apiConfig.apiAuthorityPart` extension point and does not change the altero
database schema.

## API probe

```sh
ALTERO_API='https://altero.example.com' ALTERO_API_KEY='...' ALTERO_USER_ID='...' node scripts/probe-altero.mjs
```

## Local development

```sh
node scripts/dev-server.mjs
```

Run both unit and simulated end-to-end BFF tests with:

```sh
npm test
```

For UI debugging, run `npm run dev`; development-only server and browser logs
are written to the ignored `.debug/` directory. See
`docs/human-in-loop-debugging.md` for the standard human-in-the-loop workflow.

The flow test covers OIDC discovery and signed ID Token validation, browser
binding, refresh-token rotation, protected API access, PDF Range forwarding,
token revocation, logout, and invalid-refresh failure closure.

The workspace is then available at `http://localhost:8088`. Manual API-key mode
is available only outside production and can be disabled with
`ALLOW_DIRECT_AUTH=false`. BFF mode never exposes OAuth tokens to browser code.

For local HTTP OAuth, explicitly set `ALLOW_INSECURE_OAUTH=true`. Private-network
Altero nodes additionally require `ALLOW_PRIVATE_HOSTS=true`. Production keeps
TLS verification enabled; use `NODE_EXTRA_CA_CERTS` for a private certificate
authority instead of disabling verification.

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
ALTERO_API=https://altero.example.com
SESSION_SECRET=<at-least-32-random-characters>
OAUTH_CLIENT_ID=altcanvas
OAUTH_CLIENT_SECRET=<secret-if-confidential-client>
```

Key environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8088` | Port to bind the BFF server |
| `HOST` | `0.0.0.0` | Host interface to listen on |
| `PUBLIC_ORIGIN` | `http://localhost:8088` | External public URL (must match OAuth redirect) |
| `ALTERO_API` | `http://localhost:8000` | Altero backend base URL |
| `SESSION_SECRET` | — | 32+ char key for encrypting cookie sessions across restarts |
| `AI_SETTINGS_SECRET` | — | Optional external secret for AES-256-GCM per-user AI keys |
| `AI_BASE_URL` | — | Server default OpenAI-compatible base URL |
| `AI_MODEL` | — | Server default AI model name |
| `AI_API_KEY` | — | Server default AI API Key (never sent to client) |
| `ALLOW_PRIVATE_AI_HOSTS` | `false` | Set `true` to allow private-network AI hosts (e.g. Ollama) |
| `ALLOW_INSECURE_AI` | `false` | Set `true` to allow non-HTTPS AI endpoints |
| `MAX_AI_DOCUMENT_BODY_BYTES`| `786432` | Max upload payload size for whole-document analysis |
| `MAX_AI_DOCUMENT_TEXT_CHARS`| `600000` | Max extractable character count for document understanding |
| `AI_DOCUMENT_CHUNK_CHARS` | `30000` | Character chunk size for parallel document reading |

The Altero ID Token must contain a verified `zotero_user_id` claim. Optional
group authorization comes from `zotero_groups` (an array of group IDs or
objects with an `id`). `PUBLIC_ORIGIN` must exactly match the registered OAuth
redirect origin. Set `TRUST_PROXY=true` only behind a trusted reverse proxy.

Builds require compiled Reader and Web Library assets. CI builds both
submodules before constructing the runtime image:

```sh
npm run build:vendor
docker compose build
docker compose up -d
```

`docker-compose.all-in-one.yml` uses `altero.localhost:8000` as a shared
browser/container hostname. Production deployments should put both services
behind HTTPS and set their public origins explicitly.

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
