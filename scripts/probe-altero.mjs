#!/usr/bin/env node
/**
 * Altero / Zotero API Compatibility Probe (T0 Gate)
 *
 * Verifies capabilities required for Topic Research Workspace:
 * - API Key / Token Authentication & Scopes
 * - Collection Listing & Pagination Traversals
 * - Incremental Sync (Last-Modified-Version & 'since' filtering)
 * - Collection-Item Relationship Queries
 * - Tag & Collection Mutation & Version Conflict Handling (Active Mode)
 * - Attachment Upload Protocol Verification (Active Mode)
 *
 * Security: Strictly desensitizes URLs and user IDs; never logs tokens, private document content, or binary data.
 */

const rawApi = (process.env.ALTERO_API || '').replace(/\/$/, '');
const key = process.env.ALTERO_API_KEY || process.env.ALTERO_TOKEN;
const userId = process.env.ALTERO_USER_ID;
const activeWrite = process.env.PROBE_ACTIVE_WRITE === 'true';

if (!rawApi || !key || !userId) {
  console.log(`
Altero Compatibility Probe (T0)
================================
Usage:
  ALTERO_API=https://altero.example.com ALTERO_API_KEY=... ALTERO_USER_ID=... node scripts/probe-altero.mjs

Optional Flags:
  PROBE_ACTIVE_WRITE=true   Enable active write, conflict check, and attachment upload lifecycle test
`);
  process.exit(2);
}

function maskUrl(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//***${u.hostname.slice(-8)}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return 'https://***';
  }
}

function maskId(id) {
  const str = String(id);
  return str.length > 4 ? `***${str.slice(-4)}` : '***';
}

const headers = {
  'Zotero-API-Version': '3',
  'Accept': 'application/json',
  ...(key.startsWith('Bearer ') || key.includes('.')
    ? { 'Authorization': key.startsWith('Bearer ') ? key : `Bearer ${key}` }
    : { 'Zotero-API-Key': key })
};

const results = [];

function recordResult(feature, status, details) {
  results.push({ feature, status, details });
  console.log(`[${status.padEnd(11)}] ${feature.padEnd(32)} : ${details}`);
}

async function safeFetch(path, options = {}) {
  const url = `${rawApi}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });
    return res;
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      error: err.message,
      json: async () => ({}),
      text: async () => err.message
    };
  }
}

console.log(`\n🔍 Probing Altero API endpoint: ${maskUrl(rawApi)} (User: ${maskId(userId)}, Active Write: ${activeWrite})\n`);

// 1. Identity & Permissions Check
{
  const res = await safeFetch('/keys/current');
  if (res.ok) {
    try {
      const data = await res.json();
      const access = data?.access ? Object.keys(data.access).join(', ') : 'all';
      recordResult('API Key Authentication', 'SUPPORTED', `Status 200, access scopes: [${access}]`);
    } catch {
      recordResult('API Key Authentication', 'SUPPORTED', `Status ${res.status}`);
    }
  } else if (res.status === 404 || res.status === 403) {
    recordResult('API Key Authentication', 'ADAPTED', `Key endpoint status ${res.status}, continuing with user token scope`);
  } else {
    recordResult('API Key Authentication', 'FAILED', `Status ${res.status} ${res.error || ''}`);
  }
}

// 2. Collection Listing & Multi-Page Pagination Headers
let sampleCollectionKey = null;
{
  const page1Res = await safeFetch(`/users/${userId}/collections?start=0&limit=2`);
  if (page1Res.ok) {
    const totalResults = page1Res.headers.get('total-results');
    const lastModifiedVersion = page1Res.headers.get('last-modified-version');
    const linkHeader = page1Res.headers.get('link');
    const hasPaginationHeaders = Boolean(totalResults !== null || linkHeader !== null);
    try {
      const p1Items = await page1Res.json();
      if (Array.isArray(p1Items) && p1Items.length > 0) {
        sampleCollectionKey = p1Items[0]?.key || p1Items[0]?.data?.key;
      }

      let paginationVerified = hasPaginationHeaders;
      if (Number(totalResults) > 2) {
        const page2Res = await safeFetch(`/users/${userId}/collections?start=2&limit=2`);
        if (page2Res.ok) {
          const p2Items = await page2Res.json();
          const p1Keys = new Set(p1Items.map(i => i.key || i.data?.key));
          const hasOverlap = (Array.isArray(p2Items) ? p2Items : []).some(i => p1Keys.has(i.key || i.data?.key));
          if (hasOverlap) {
            paginationVerified = false;
            recordResult('Pagination Traversal', 'UNSUPPORTED', 'Overlapping keys returned across start offsets');
          } else {
            recordResult('Pagination Traversal', 'SUPPORTED', 'Distinct items returned for start=0 and start=2');
          }
        }
      }

      recordResult('Collection Listing', 'SUPPORTED', `Count: ${Array.isArray(p1Items) ? p1Items.length : 0}, Total-Results: ${totalResults ?? 'n/a'}, Version: ${lastModifiedVersion ?? 'n/a'}`);
      recordResult('Pagination Headers', paginationVerified ? 'SUPPORTED' : 'ADAPTED', `Link: ${linkHeader ? 'present' : 'none'}, Total-Results: ${totalResults ?? 'none'}`);
    } catch {
      recordResult('Collection Listing', 'FAILED', 'Non-JSON body returned');
    }
  } else {
    recordResult('Collection Listing', 'FAILED', `Status ${page1Res.status} ${page1Res.error || ''}`);
  }
}

// 3. Incremental Sync (since parameter & version verification)
{
  const baselineRes = await safeFetch(`/users/${userId}/items?limit=5`);
  if (baselineRes.ok) {
    const versionHeader = baselineRes.headers.get('last-modified-version');
    const baselineItems = await baselineRes.json().catch(() => []);
    const baselineCount = Array.isArray(baselineItems) ? baselineItems.length : 0;

    if (!versionHeader) {
      recordResult('Incremental Sync (since)', 'UNSUPPORTED', 'Upstream did not return Last-Modified-Version header');
    } else {
      const currentVersion = Number(versionHeader);
      const sinceRes = await safeFetch(`/users/${userId}/items?since=${currentVersion}&limit=5`);
      if (sinceRes.ok) {
        const sinceItems = await sinceRes.json().catch(() => []);
        const sinceCount = Array.isArray(sinceItems) ? sinceItems.length : 0;
        if (baselineCount > 0 && sinceCount === baselineCount) {
          recordResult('Incremental Sync (since)', 'UNSUPPORTED', `Upstream ignored since=${currentVersion} and returned all items`);
        } else if (sinceCount === 0) {
          recordResult('Incremental Sync (since)', 'SUPPORTED', `Verified 0 items returned for since=${currentVersion}`);
        } else {
          recordResult('Incremental Sync (since)', 'SUPPORTED', `Filtered items returned for since=${currentVersion}`);
        }
      } else if (sinceRes.status === 400) {
        recordResult('Incremental Sync (since)', 'UNSUPPORTED', 'Status 400: since query param not supported by upstream');
      } else {
        recordResult('Incremental Sync (since)', 'ADAPTED', `Status ${sinceRes.status} on since query`);
      }
    }
  } else {
    recordResult('Incremental Sync (since)', 'FAILED', `Status ${baselineRes.status} on baseline items query`);
  }
}

// 4. Collection-Item Relation Query
if (sampleCollectionKey) {
  const res = await safeFetch(`/users/${userId}/collections/${sampleCollectionKey}/items?limit=5`);
  if (res.ok) {
    recordResult('Collection Items Query', 'SUPPORTED', `Status 200 for collection items`);
  } else {
    recordResult('Collection Items Query', 'ADAPTED', `Status ${res.status} for collection items endpoint`);
  }
} else {
  recordResult('Collection Items Query', 'SKIPPED', 'No collection available to test relation query');
}

// 5. Item Schema & Attachment Detection Check
let sampleItemKey = null;
let sampleAttachmentKey = null;
{
  const res = await safeFetch(`/users/${userId}/items/top?limit=5`);
  if (res.ok) {
    try {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0) {
        sampleItemKey = items[0]?.key || items[0]?.data?.key;
      }
      recordResult('Top-Level Items Query', 'SUPPORTED', `Found ${Array.isArray(items) ? items.length : 0} items`);
    } catch {
      recordResult('Top-Level Items Query', 'FAILED', 'Non-JSON response');
    }
  } else {
    recordResult('Top-Level Items Query', 'FAILED', `Status ${res.status}`);
  }
}

if (sampleItemKey) {
  const res = await safeFetch(`/users/${userId}/items/${sampleItemKey}/children`);
  if (res.ok) {
    try {
      const children = await res.json();
      const attachment = Array.isArray(children) ? children.find(c => (c?.data?.itemType || c?.itemType) === 'attachment') : null;
      if (attachment) {
        sampleAttachmentKey = attachment?.key || attachment?.data?.key;
        recordResult('Attachment Detection', 'SUPPORTED', `Found existing attachment child`);
      } else {
        recordResult('Attachment Detection', 'SUPPORTED', `Queried children successfully (no attachment on sample item)`);
      }
    } catch {
      recordResult('Attachment Detection', 'ADAPTED', 'Unable to parse children items');
    }
  }
}

// 6. Active Mutation, Version Conflict, and Attachment Upload Probe
if (activeWrite) {
  let createdItemKey = null;
  let latestItemVersion = null;
  let createdAttachmentKey = null;
  let latestAttachmentVersion = null;
  try {
    // 6a. Create temporary test item
    const createRes = await safeFetch(`/users/${userId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        itemType: 'journalArticle',
        title: 'AltCanvas Probe Test Item (Safe Cleanup)',
        tags: [{ tag: 'altcanvas-probe' }]
      }])
    });

    if (createRes.ok || createRes.status === 200 || createRes.status === 201) {
      const createData = await createRes.json().catch(() => ({}));
      createdItemKey = createData.successful?.['0']?.key || createData[0]?.key;
      const initialVersion = createData.successful?.['0']?.version ?? createData[0]?.version ?? 0;
      latestItemVersion = initialVersion;
      recordResult('Item Creation', 'SUPPORTED', `Created test item with version ${initialVersion}`);

      if (createdItemKey) {
        // 6b. Update tags and collections with version header
        const patchBody = {
          tags: [{ tag: 'altcanvas-probe' }, { tag: 'probe-updated' }],
          extra: 'AltCanvas Probe Verified',
          ...(sampleCollectionKey ? { collections: [sampleCollectionKey] } : {})
        };
        const patchRes = await safeFetch(`/users/${userId}/items/${createdItemKey}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'If-Unmodified-Since-Version': String(latestItemVersion)
          },
          body: JSON.stringify(patchBody)
        });
        if (patchRes.ok || patchRes.status === 204 || patchRes.status === 200) {
          const patchVersion = patchRes.headers.get('last-modified-version');
          if (patchVersion) latestItemVersion = Number(patchVersion);
          else latestItemVersion = latestItemVersion + 1;
          recordResult('Tag & Metadata Mutation', 'SUPPORTED', 'Successfully updated item tags and extra metadata');

          if (sampleCollectionKey) {
            const itemCheckRes = await safeFetch(`/users/${userId}/items/${createdItemKey}`);
            const itemData = itemCheckRes.ok ? await itemCheckRes.json().catch(() => ({})) : {};
            const itemCollections = itemData?.data?.collections || itemData?.collections || [];
            const isMemberOnItem = Array.isArray(itemCollections) && itemCollections.includes(sampleCollectionKey);

            if (isMemberOnItem) {
              recordResult('Collection Item Association', 'SUPPORTED', `Verified item membership in collection ${maskId(sampleCollectionKey)}`);
            } else {
              // Fallback to query collection items directly
              const colCheckRes = await safeFetch(`/users/${userId}/collections/${sampleCollectionKey}/items?limit=50`);
              const colItems = colCheckRes.ok ? await colCheckRes.json().catch(() => []) : [];
              const isMemberOnCol = (Array.isArray(colItems) ? colItems : []).some(i => (i.key || i.data?.key) === createdItemKey);
              if (isMemberOnCol) {
                recordResult('Collection Item Association', 'SUPPORTED', `Verified item membership in collection ${maskId(sampleCollectionKey)}`);
              } else {
                recordResult('Collection Item Association', 'ADAPTED', `Item patched into collection but not confirmed in readback`);
              }
            }
          } else {
            recordResult('Collection Item Association', 'SKIPPED', 'No sample collection available to test membership write');
          }
        } else {
          recordResult('Tag & Metadata Mutation', 'FAILED', `Status ${patchRes.status} on item patch`);
          recordResult('Collection Item Association', 'FAILED', `Status ${patchRes.status} on collection item patch`);
        }

        // 6c. Test optimistic version conflict check (stale version 0)
        const conflictRes = await safeFetch(`/users/${userId}/items/${createdItemKey}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'If-Unmodified-Since-Version': '0'
          },
          body: JSON.stringify({ extra: 'Stale update' })
        });
        if (conflictRes.status === 412) {
          recordResult('Version Conflict Enforcement', 'SUPPORTED', 'Status 412 returned on stale version');
        } else {
          recordResult('Version Conflict Enforcement', 'ADAPTED', `Status ${conflictRes.status} on stale version (expected 412)`);
        }

        // 6d. Create child attachment item
        const attachItemRes = await safeFetch(`/users/${userId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{
            itemType: 'attachment',
            parentItem: createdItemKey,
            linkMode: 'imported_file',
            title: 'probe.txt',
            contentType: 'text/plain'
          }])
        });
        if (attachItemRes.ok || attachItemRes.status === 200 || attachItemRes.status === 201) {
          const attachData = await attachItemRes.json().catch(() => ({}));
          createdAttachmentKey = attachData.successful?.['0']?.key || attachData[0]?.key;
          latestAttachmentVersion = attachData.successful?.['0']?.version ?? attachData[0]?.version ?? 0;
          recordResult('Attachment Item Creation', 'SUPPORTED', 'Created child attachment entity');

          // 6e. Test upload authorization handshake
          if (createdAttachmentKey) {
            const uploadHandshakeRes = await safeFetch(`/users/${userId}/items/${createdAttachmentKey}/file?upload=1`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'If-None-Match': '*'
              },
              body: 'md5=00000000000000000000000000000000&filename=probe.txt&filesize=0&mtime=0'
            });
            if (uploadHandshakeRes.status === 200 || uploadHandshakeRes.status === 204 || uploadHandshakeRes.status === 304) {
              recordResult('Attachment Upload Handshake', 'HANDSHAKE_SUPPORTED', `Upload registration handshake succeeded (${uploadHandshakeRes.status})`);
              recordResult('Full Attachment Upload & Readback', 'DEFERRED', 'Complete binary storage upload and roundtrip content readback deferred to dedicated storage adapter probe');
            } else {
              recordResult('Attachment Upload Handshake', 'ADAPTED', `Upload endpoint returned status ${uploadHandshakeRes.status}`);
              recordResult('Full Attachment Upload & Readback', 'DEFERRED', 'Storage upload deferred pending handshake adaptation');
            }
          }
        } else {
          recordResult('Attachment Item Creation', 'FAILED', `Status ${attachItemRes.status}`);
        }
      }
    } else {
      recordResult('Item Creation', 'FAILED', `Status ${createRes.status}`);
    }
  } finally {
    // 6f. Clean up test entities with version validation and failure detection
    let cleanupFailed = false;
    if (createdAttachmentKey) {
      const deleteAttachRes = await safeFetch(`/users/${userId}/items/${createdAttachmentKey}`, {
        method: 'DELETE',
        headers: latestAttachmentVersion ? { 'If-Unmodified-Since-Version': String(latestAttachmentVersion) } : {}
      });
      if (!deleteAttachRes.ok && deleteAttachRes.status !== 204 && deleteAttachRes.status !== 200 && deleteAttachRes.status !== 404) {
        cleanupFailed = true;
        recordResult('Test Entity Cleanup (Attachment)', 'FAILED', `Status ${deleteAttachRes.status} deleting attachment ${maskId(createdAttachmentKey)}. Manual cleanup required.`);
      }
    }
    if (createdItemKey) {
      const deleteItemRes = await safeFetch(`/users/${userId}/items/${createdItemKey}`, {
        method: 'DELETE',
        headers: latestItemVersion ? { 'If-Unmodified-Since-Version': String(latestItemVersion) } : {}
      });
      if (!deleteItemRes.ok && deleteItemRes.status !== 204 && deleteItemRes.status !== 200 && deleteItemRes.status !== 404) {
        cleanupFailed = true;
        recordResult('Test Entity Cleanup (Item)', 'FAILED', `Status ${deleteItemRes.status} deleting item ${maskId(createdItemKey)}. Manual cleanup required.`);
      }
    }
    if (!cleanupFailed && (createdAttachmentKey || createdItemKey)) {
      recordResult('Test Entity Cleanup', 'SUPPORTED', 'Temporary test entities safely cleaned up with version headers');
    }
  }
} else {
  recordResult('Tag & Metadata Mutation', 'DEFERRED', 'Run with PROBE_ACTIVE_WRITE=true to test item tag/extra write mutations');
  recordResult('Collection Item Association', 'DEFERRED', 'Run with PROBE_ACTIVE_WRITE=true to test collection binding and membership write');
  recordResult('Attachment Upload Handshake', 'DEFERRED', 'Run with PROBE_ACTIVE_WRITE=true to test upload authorization handshake');
  recordResult('Full Attachment Upload & Readback', 'DEFERRED', 'Run with PROBE_ACTIVE_WRITE=true to test full upload protocol lifecycle');
}

console.log('\n================================================================');
console.log('T0 Compatibility Probe Summary');
console.log('================================================================');
const passed = results.filter(r => r.status === 'SUPPORTED' || r.status === 'HANDSHAKE_SUPPORTED').length;
const adapted = results.filter(r => r.status === 'ADAPTED').length;
const deferred = results.filter(r => r.status === 'DEFERRED' || r.status === 'SKIPPED').length;
const failed = results.filter(r => r.status === 'FAILED' || r.status === 'UNSUPPORTED').length;

console.log(`Passed: ${passed} | Adapted: ${adapted} | Deferred: ${deferred} | Unsupported/Failed: ${failed}\n`);

if (failed > 0) {
  console.log('❌ Gate check failed: probe encountered unsupported or failed operations.\n');
  process.exitCode = 1;
} else if (deferred > 0 || !activeWrite) {
  console.log('⚠️  T0 Compatibility Gate status: IN_PROGRESS (Partial / Deferred capabilities remain).');
  console.log('   Full active lifecycle (writes, conflict checks, upload protocol) has not yet closed.');
  console.log('   Canvas PDF upload features MUST remain gated until full active test passes.\n');
  if (process.env.PROBE_STRICT === 'true' || process.env.REQUIRE_T0_COMPLETE === 'true') {
    process.exitCode = 1;
  }
} else {
  console.log('✅ T0 Compatibility Gate: ALL REQUIRED TESTS PASSED.\n');
}
