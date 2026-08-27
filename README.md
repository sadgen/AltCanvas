# AltCanvas

Self-hosted AI research workspace built on Zotero-compatible infrastructure.

## Current status

The Zotero Desktop A → altero → Zotero Desktop B sync path has been verified.
The next goal is to validate the web integration before building Canvas or AI.

## Repository layout

- `vendor/web-library` — upstream Zotero Web Library source
- `vendor/reader` — upstream Zotero Reader source
- `docs/m0-validation.md` — integration checkpoints and test matrix
- `docs/m1-api-adaptation.md` — Web Library endpoint, auth, CORS, and file contract
- `docs/altero-auth-bff-design.md` — production login, OAuth/OIDC, BFF, token, and privacy design
- `config/altero.web-library.example.json` — runtime-injected Web Library configuration
- `scripts/probe-altero.mjs` — credential-free-in-repo API compatibility probe

## Development principle

AltCanvas must use Zotero-compatible data for items, attachments, notes, and
annotations. Canvas, workspace, and AI provenance data will live in a separate
AltCanvas service and database. Do not modify the altero database schema.

## Next milestone

Connect the Web Library and Reader to the verified altero node, then test web
annotation round-trip.

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

The workspace is then available at `http://localhost:8088`. The API key is kept
in `sessionStorage`, so it is cleared when the browser tab/session ends and is
never placed in the PDF request URL.

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
