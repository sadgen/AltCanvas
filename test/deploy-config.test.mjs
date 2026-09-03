import assert from 'assert/strict';
import fs from 'fs';

console.log('🧪 Running deployment configuration regression tests...');

// Static, network-free assertions relative to the repository root
// (this test lives in test/, so '../' resolves to the repo root).
function readRepoFile(relativePath) {
  return fs.readFileSync(new URL(relativePath, new URL('../', import.meta.url)), 'utf8');
}

function repoFileExists(relativePath) {
  return fs.existsSync(new URL(relativePath, new URL('../', import.meta.url)));
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// 1. Retired Altero/OAuth environment variables must not appear anywhere in
//    the deployment configuration — not even in comments. M4 removed every
//    code path that read them.
const retiredEnvVars = [
  'ALTERO_API',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'ALLOW_DYNAMIC_ALTERO',
  'ALLOW_PRIVATE_HOSTS',
  'ALLOW_INSECURE_OAUTH',
  'ALLOW_DIRECT_AUTH',
  'AUTH_MODE'
];

const dockerfile = readRepoFile('Dockerfile');
const dockerCompose = readRepoFile('docker-compose.yml');

for (const retiredVar of retiredEnvVars) {
  assert.equal(dockerfile.includes(retiredVar), false,
    `Dockerfile must not reference the retired variable ${retiredVar}`);
  assert.equal(dockerCompose.includes(retiredVar), false,
    `docker-compose.yml must not reference the retired variable ${retiredVar}`);
}
console.log('✅ Dockerfile and docker-compose.yml contain no retired Altero/OAuth variables');

// 2. The all-in-one stack bundled the retired external library service; the
//    file was removed and must stay removed (git history preserves it).
assert.equal(repoFileExists('docker-compose.all-in-one.yml'), false,
  'docker-compose.all-in-one.yml must not exist; the bundled stack was retired in M4');
console.log('✅ docker-compose.all-in-one.yml is removed');

// 3. The standard compose file must not revive external library services.
assert.equal(dockerCompose.includes('altero'), false,
  'docker-compose.yml must not define or reference an altero service');
assert.equal(dockerCompose.includes('postgres'), false,
  'docker-compose.yml must not define or reference a postgres service');
assert.equal(dockerCompose.includes('depends_on'), false,
  'docker-compose.yml must not declare depends_on references to removed services');
console.log('✅ docker-compose.yml has no altero/postgres services or depends_on references');

// 4. The native library mount and its server-side root configuration must be
//    wired up (the only library root source read by the server is
//    NATIVE_LIBRARY_ROOTS in server/canvas-api.mjs).
assert.equal(dockerCompose.includes('NATIVE_LIBRARY_ROOTS'), true,
  'docker-compose.yml must set NATIVE_LIBRARY_ROOTS for the native library');
assert.equal(dockerCompose.includes(':/app/library'), true,
  'docker-compose.yml must mount a host library directory at /app/library');
console.log('✅ docker-compose.yml wires NATIVE_LIBRARY_ROOTS to a mounted library directory');

// 5. README must describe the native architecture only. The removed probe
//    script and the retired integration vocabulary must not be documented.
const readme = readRepoFile('README.md');
assert.equal(readme.includes('probe-altero.mjs'), false,
  'README must not reference the removed probe-altero.mjs script');
assert.equal(countOccurrences(readme, 'OIDC'), 0,
  'README must not mention OIDC; the flow was removed in M4');
assert.equal(countOccurrences(readme, 'Zotero'), 0,
  'README must not mention Zotero; external library integration was removed in M4');
assert.equal(readme.includes('NATIVE_LIBRARY_ROOTS'), true,
  'README must document NATIVE_LIBRARY_ROOTS');
console.log('✅ README documents the native architecture without retired integration references');

// 6. package.json metadata must drop the retired branding and run the
//    deployment configuration regression as part of the test chain.
const packageJson = JSON.parse(readRepoFile('package.json'));
const descriptionLower = String(packageJson.description).toLowerCase();
assert.equal(descriptionLower.includes('altero'), false,
  'package.json description must not mention altero');
assert.equal(descriptionLower.includes('zotero'), false,
  'package.json description must not mention zotero');
const keywordsLower = packageJson.keywords.map(keyword => String(keyword).toLowerCase());
for (const keyword of keywordsLower) {
  assert.equal(keyword.includes('altero'), false,
    `package.json keywords must not mention altero (found "${keyword}")`);
  assert.equal(keyword.includes('zotero'), false,
    `package.json keywords must not mention zotero (found "${keyword}")`);
}
assert.equal(packageJson.scripts.test.includes('deploy-config.test.mjs'), true,
  'npm test must run test/deploy-config.test.mjs');
console.log('✅ package.json metadata is native-only and the test chain includes deploy-config tests');

// 7. Historical design documents must be visibly marked as archived.
const archivedDocs = [
  'docs/altero-auth-bff-design.md',
  'docs/topic-research-workspace-design.md',
  'docs/m0-validation.md',
  'docs/m1-api-adaptation.md'
];
for (const docPath of archivedDocs) {
  const doc = readRepoFile(docPath);
  assert.equal(doc.includes('已归档') || doc.includes('superseded'), true,
    `${docPath} must carry a visible archive/superseded banner`);
  assert.equal(doc.includes('archive/last-altero-compatible'), true,
    `${docPath} must reference the archive/last-altero-compatible git tag`);
}
console.log('✅ All four historical design documents are marked as archived');

console.log('🎉 All deployment configuration regression tests passed!');
