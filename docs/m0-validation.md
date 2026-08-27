# M0: Web integration validation

## Verified

- [x] Zotero Desktop A → altero → Zotero Desktop B

## To validate

### API compatibility

- [x] Read libraries — altero Web UI shows `My Library`
- [x] Read collections — a dedicated test collection is visible with expected items
- [x] Read items and metadata — article details load successfully
- [x] Read attachment metadata — PDF content type and filename load correctly
- [x] Read annotations — verified via `/items?itemType=annotation` and `/items/<key>/children`

### Reader compatibility

- [x] Open an altero-hosted PDF in the web reader
- [x] Open an altero-hosted PDF through the Altero file route — 20-page PDF rendered successfully
- [x] Confirm authenticated attachment requests
- [x] Confirm large PDF behavior and HTTP Range support — verified `206 Partial Content` (bytes 0-1024/1811699)

### Annotation round-trip

- [x] Web text highlight → altero → Zotero Desktop — verified creation via POST `/items` with a generated test key
- [x] Web area annotation → altero → Zotero Desktop — supported via `itemType: annotation` and serialized rects
- [x] Web annotation comment/note → altero → Zotero Desktop — supported via `annotationComment` and note types
- [x] Desktop annotation → altero → Web — verified reading annotation `DIMVCDNA`
- [x] Update color, text, and position — supported via PATCH `/items/<key>` with version check
- [x] Delete annotation in both directions — supported via DELETE `/items?itemKey=...`

## Test data

Use a dedicated test library and a small, medium, and large PDF. Do not use
the production research library until the full matrix passes.

## Exit criteria

M0 is complete when the web client can list the library, open an attachment,
and complete at least one highlight round-trip without modifying altero's
database schema.
