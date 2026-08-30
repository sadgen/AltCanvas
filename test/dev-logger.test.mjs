import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-debug-log-'));
process.env.DEBUG_LOG_DIR = tempDirectory;
process.env.NODE_ENV = 'development';

const {
  devLogPaths,
  handleBrowserLog,
  writeDevLog,
} = await import(`../server/dev-logger.mjs?test=${Date.now()}`);

writeDevLog('error', 'test.server', 'Bearer very-secret-token', {
  authorization: 'Bearer should-not-appear',
  endpoint: '/api/items?access_token=hidden',
  stack: 'test stack',
});

const serverEntry = JSON.parse(fs.readFileSync(devLogPaths.server, 'utf8').trim());
assert.equal(serverEntry.level, 'error');
assert.equal(serverEntry.source, 'test.server');
assert.match(serverEntry.message, /\[REDACTED\]/);
assert.equal(serverEntry.authorization, '[REDACTED]');
assert.doesNotMatch(JSON.stringify(serverEntry), /very-secret-token|should-not-appear|access_token=hidden/);

const payload = JSON.stringify({
  events: [{
    level: 'error',
    source: 'fetch.response',
    message: 'HTTP 500 GET /api/items',
    route: '/',
    request: {
      method: 'GET',
      endpoint: '/api/items?api_key=private',
      status: 500,
      responseSummary: 'password=private failure',
    },
  }],
});
const request = Readable.from([Buffer.from(payload)]);
let responseStatus;
const response = {
  writeHead(status) { responseStatus = status; },
  end() {},
};
await handleBrowserLog(request, response);
assert.equal(responseStatus, 204);

const browserEntry = JSON.parse(fs.readFileSync(devLogPaths.browser, 'utf8').trim());
assert.equal(browserEntry.request.status, 500);
assert.equal(browserEntry.request.endpoint, '/api/items?api_key=[REDACTED]');
assert.doesNotMatch(JSON.stringify(browserEntry), /api_key=private|password=private/);

writeDevLog('error', 'test.identifiers', 'scrub source identifiers', {
  endpoint: '/api/groups/123/items/SECRETITEM/children',
});
const serverEntries = fs.readFileSync(devLogPaths.server, 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(serverEntries.at(-1).endpoint, '/api/groups/:library/items/:item/children');

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /window\.addEventListener\('error'/);
assert.match(indexHtml, /window\.addEventListener\('unhandledrejection'/);
assert.match(indexHtml, /source: 'fetch\.response'/);
assert.match(indexHtml, /source: 'reader\.window\.error'/);
assert.match(indexHtml, /debugExpectedStatuses/);
assert.match(indexHtml, /\[external endpoint\]/);

process.env.NODE_ENV = 'production';
const productionLogger = await import(`../server/dev-logger.mjs?production-test=${Date.now()}`);
assert.equal(productionLogger.devLoggingEnabled, false);
let productionStatus;
productionLogger.handleDebugConfig({}, {
  writeHead(status) { productionStatus = status; },
  end() {},
});
assert.equal(productionStatus, 404);

fs.rmSync(tempDirectory, { recursive: true, force: true });
console.log('Development logging tests passed.');
