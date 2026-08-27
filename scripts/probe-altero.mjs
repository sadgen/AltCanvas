const api = (process.env.ALTERO_API || '').replace(/\/$/, '');
const key = process.env.ALTERO_API_KEY;
const userId = process.env.ALTERO_USER_ID;

if (!api || !key || !userId) {
	console.error('Usage: ALTERO_API=https://altero.example.com ALTERO_API_KEY=... ALTERO_USER_ID=... node scripts/probe-altero.mjs');
	process.exit(2);
}

const headers = {
	'Zotero-API-Key': key,
	'Zotero-API-Version': '3',
};

const checks = [
	['key identity & permissions', '/keys/current'],
	['collections', `/users/${userId}/collections?limit=1`],
	['top-level items', `/users/${userId}/items/top?limit=1`],
];

for (const [name, path] of checks) {
	const response = await fetch(`${api}${path}`, { headers });
	const contentType = response.headers.get('content-type') || '';
	console.log(`${name}: ${response.status} ${contentType}`);
	if (!response.ok) {
		console.error((await response.text()).slice(0, 500));
		process.exitCode = 1;
		continue;
	}
	try {
		const body = await response.json();
		const shape = Array.isArray(body) ? `array(${body.length})` : typeof body;
		console.log(`  shape: ${shape}; api-version: ${response.headers.get('zotero-api-version') || '(missing)'}`);
	} catch {
		console.log('  body: non-JSON');
	}
}
