import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler } from '../server/canvas-api.mjs';
import { createSession, destroySession } from '../server/session.mjs';
import { getFileLocation, mappedFileLocations } from '../server/file-location.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-paths-'));
const library = path.join(directory, 'library'); fs.mkdirSync(library);
const store = new CanvasStore(path.join(directory, 'canvas.sqlite'));
const actor = canvasActorKey('local', 'path-test');
const root = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath: library, displayName: 'Path test' }])[0];
const relative = "quote's test.txt", bytes = Buffer.from('Original source text'); fs.writeFileSync(path.join(library, relative), bytes);
const sf = store.createSourceFile(actor, root.id, { relativePath: relative, filename: relative,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, status: 'active' });
const doc = store.enrollExistingSourceFile(actor, sf.id).document;
const session = createSession({ issuer: 'local', subject: 'path-test', userId: 'path-test', groupIds: [] });
const foreign = createSession({ issuer: 'local', subject: 'other', userId: 'other', groupIds: [] });
class Response extends EventEmitter {
  statusCode; chunks=[];
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.emit('finish'); }
  get data() { return JSON.parse(Buffer.concat(this.chunks).toString()); }
}
const handler = createCanvasHandler(store);
async function call(url, selected = session) {
  const response = new Response();
  await handler({ method:'GET', headers:{cookie:`altcanvas_session=${selected.id}`}, socket:{encrypted:false} }, response, new URL(url,'http://test.example'));
  return response;
}
try {
  const read = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('Path lookup must not read file contents'); };
  let location;
  try { location = getFileLocation(store, actor, { documentId: doc.id, mappings:'[]' }); }
  finally { fs.readFileSync = read; }
  assert.equal(location.locations[0].path, fs.realpathSync(path.join(library, relative)));
  const mapping = JSON.stringify([{ ownerKey:actor, rootId:root.id, label:'5.233', targetRoot:'Z:\\reports' },
    { ownerKey:actor, rootId:root.id, label:'SeaDrive', targetRoot:'C:\\cloud', onDemand:true, verifiedRelativePaths:['org/paper.pdf'] }]);
  const mapped = mappedFileLocations(actor, root.id, 'org/paper.pdf', mapping);
  assert.equal(mapped.locations[0].path, 'Z:\\reports\\org\\paper.pdf');
  assert.equal(mapped.locations[1].onDemand, true);
  assert.equal(mappedFileLocations(actor, root.id, 'org/new.pdf', mapping).locations.length, 1, 'unverified cloud copies must not be offered');
  assert.equal(mappedFileLocations('foreign', root.id, 'org/paper.pdf', mapping).locations.length, 0, 'other owners cannot see configured paths');
  assert.throws(() => mappedFileLocations(actor, root.id, '../escape.pdf', mapping));
  assert.equal(mappedFileLocations(actor, root.id, 'org/CON.pdf', mapping).locations.length, 0, 'invalid Windows names must not produce unusable paths');
  let response = await call(`/canvas/native/documents/${doc.id}/file-location`);
  assert.equal(response.statusCode,200); assert.equal(response.headers['Cache-Control'],'no-store');
  response = await call(`/canvas/native/documents/${doc.id}/file-location`,foreign);
  assert.equal(response.statusCode,404); assert.equal(response.data.data,undefined);
  response = await call(`/canvas/native/source-files/${sf.id}/file-location`,foreign);
  assert.equal(response.statusCode,404);
  store.updateSourceFile(actor,sf.id,{status:'missing'});
  assert.equal((await call(`/canvas/native/source-files/${sf.id}/file-location`)).statusCode,404);
} finally { destroySession(session.id); destroySession(foreign.id); store.close(); fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }

const code=fs.readFileSync(new URL('../assets/file-path-copy.js',import.meta.url),'utf8');
let copied, removed=false, restored=false;
const context=vm.createContext({ navigator:{clipboard:{writeText:async()=>{throw new Error('HTTP clipboard blocked');}}},
  document:{activeElement:{focus(){restored=true;}},createElement(){return {style:{},focus(){},select(){},remove(){removed=true;}};},
    body:{appendChild(input){copied=input.value;}},execCommand:command=>command==='copy'} });
vm.runInContext(code,context);
await context.AltCanvasFilePathCopy.copy('Z:\\reports\\paper.pdf');
assert.equal(copied,'Z:\\reports\\paper.pdf'); assert.equal(removed,true); assert.equal(restored,true);
console.log('✅ File path ownership, containment, Windows/cloud mappings, metadata-only lookup and HTTP clipboard fallback passed');
