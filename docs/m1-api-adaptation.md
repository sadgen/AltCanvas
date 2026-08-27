# M1: Zotero-compatible API adaptation

This document records the contract that `vendor/web-library` expects from an
Altero endpoint. It is intentionally credential-free; use a dedicated test
library and inject the key at runtime.

## Web Library configuration

The upstream application reads JSON from `#zotero-web-library-config` and
passes `apiConfig` to `zotero-api-client`:

```json
{
  "userId": "<zotero-user-id>",
  "userSlug": "<local-user-slug>",
  "apiKey": "<runtime-injected-key>",
  "apiConfig": {
    "apiAuthorityPart": "altero.example.com",
    "apiVersion": 3,
    "retry": 2
  },
  "libraries": {
    "includeMyLibrary": true,
    "includeUserGroups": true,
    "include": []
  }
}
```

`apiAuthorityPart` is the Web Library extension point. The upstream default is
`api.zotero.org`; the scheme is supplied by the client, so the authority value
must not contain `https://`. If the client version in use does not recognize
`apiVersion`, the server must still accept `Zotero-API-Version: 3`; verify this
with the probe before changing the client.

## Required read contract

For a personal library, `<prefix>` is `/users/<userId>`; for a group it is
`/groups/<groupId>`.

| Capability | Request | Expected result |
| --- | --- | --- |
| Library identity | `GET /users/<id>` | JSON object with `library` and `meta` |
| Collections | `GET <prefix>/collections` | JSON array, pagination headers |
| Top-level items | `GET <prefix>/items/top` | JSON array of item objects |
| Children/attachments | `GET <prefix>/items/<key>/children` | JSON array; attachments have `itemType: attachment` |
| Annotations | `GET <prefix>/items?itemType=annotation` or child-item query | JSON annotation items with `parentItem` |
| Attachment URL | `GET <prefix>/items/<attachmentKey>/file/view/url` | plain-text URL, reachable by browser `fetch()` |
| Full text (optional for M1) | `GET <prefix>/items/<attachmentKey>/fulltext` | JSON full-text object or `404` |

Responses should implement Zotero API v3 JSON (`data`, `key`, `version`,
`library`, `links`, `meta`) and return `Zotero-API-Version: 3`.

## Authentication and browser requirements

Web Library sends the configured key as a Zotero API key. The endpoint must
accept `Zotero-API-Key: <key>` (and preferably `Authorization: Bearer <key>`)
on both read and write requests. CORS must allow the Web Library origin,
`GET, POST, PUT, PATCH, DELETE, OPTIONS`, and request headers including
`Zotero-API-Key`, `Zotero-API-Version`, `If-Match`, `If-None-Match`, and
`Zotero-Write-Token`. Do not use `Access-Control-Allow-Origin: *` with
credentials.

The attachment URL returned by `/file/view/url` must itself be CORS-readable,
support `GET`, and support HTTP byte ranges (`Accept-Ranges: bytes`, `206
Partial Content`, and correct `Content-Range`). A redirect to a URL on a
different origin is not sufficient unless that origin also exposes the needed
CORS headers.

## Safe validation

Run the requests below with a test user/key. Keep the key in the shell
environment and never commit it:

```sh
export ALTERO_API_KEY='...'
export ALTERO_USER_ID='...'
export ALTERO_API='https://altero.example.com'

curl -fsS -D - \
  -H "Zotero-API-Key: $ALTERO_API_KEY" \
  -H 'Zotero-API-Version: 3' \
  "$ALTERO_API/users/$ALTERO_USER_ID/collections?limit=1"
```

Record the response status, CORS headers, API version, JSON shape, and the
attachment URL/range results in a private test log once a test item is
available. Do not commit private hostnames, IP addresses, library names, item
keys, usernames, or response bodies.

## Observed Altero Web UI route

After signing in to a test node, the library UI successfully displayed the
test library and an attachment link shaped like:

```text
/web/libraries/<libraryID>/items/<itemKey>/file
```

This confirms attachment access in the Altero UI, but it is not the upstream
Web Library route `/users/<userID>/items/<itemKey>/file/view/url`. The adapter
must either expose the standard Zotero-compatible route or add a Web
Library-specific attachment URL resolver. The UI route alone is not enough:
the Reader also needs a fetchable PDF URL and annotation writes still require
Zotero item endpoints.
