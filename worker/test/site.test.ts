/**
 * The worker serving the dashboard itself.
 *
 * One service, one origin: the built site, the runtime config it needs, and
 * the API side by side. These pin the three things that have to stay true for
 * that to work — the site's routes fall back to index.html, the API's do not,
 * and /config.js tells the browser what it needs and nothing more.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { MemoryStore } from './helpers.js';

const WEB = 'https://savebot.example';

/** A stand-in for web/dist: an index page and one hashed asset. */
function fakeBuild(): string {
  const root = mkdtempSync(join(tmpdir(), 'savebot-web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>SaveBot</title><div id="root"></div>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("app")');
  return root;
}

function serve(extra: Partial<AppDeps> = {}) {
  const app = createApp({
    webUrl: WEB,
    verifyToken: async () => {
      throw new Error('unused');
    },
    constructEvent: () => {
      throw new Error('unused');
    },
    store: new MemoryStore(),
    billing: {
      checkoutUrl: async () => 'x',
      portalUrl: async () => 'x',
      cancelAll: async () => {},
      handleEvent: async () => {},
    },
    sessions: { count: () => 0 },
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'anon-key-123',
    ...extra,
  });
  const server = app.listen(0);
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string) => fetch(base + path);
}

test('/config.js gives the browser the Supabase settings and nothing else', async () => {
  const get = serve();
  const res = await get('/config.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a changed key must not be served stale');

  const body = await res.text();
  const match = /^window\.__SAVEBOT__ = (.*);$/.exec(body);
  assert.ok(match, body);
  assert.deepEqual(JSON.parse(match[1]!), {
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'anon-key-123',
  });
});

test('/config.js cannot be made to close a script context', async () => {
  const get = serve({ supabaseAnonKey: '</script><script>alert(1)</script>' });
  const body = await (await get('/config.js')).text();
  assert.doesNotMatch(body, /<\/script>/i);
});

test('the site is served, and its routes fall back to index.html', async () => {
  const get = serve({ webRoot: fakeBuild() });

  for (const path of ['/', '/dashboard', '/settings', '/admin']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<title>SaveBot<\/title>/, path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', `${path}: a deploy must reach people`);
  }
});

test('hashed assets are served and cached for ever', async () => {
  const get = serve({ webRoot: fakeBuild() });
  const res = await get('/assets/index-abc123.js');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'console.log("app")');
  assert.match(res.headers.get('cache-control') ?? '', /immutable/);
});

test('an unknown API route is still a JSON 404, not the dashboard', async () => {
  // If the fallback swallowed /api, a typo in a route would answer 200 with
  // an HTML page and every client would fail confusingly on JSON.parse.
  const get = serve({ webRoot: fakeBuild() });
  const res = await get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('health still answers with the site mounted', async () => {
  const get = serve({ webRoot: fakeBuild() });
  assert.deepEqual(await (await get('/health')).json(), { ok: true, sockets: 0 });
});

test('with no build present the worker is API-only and says so with a 404', async () => {
  const get = serve({ webRoot: join(tmpdir(), 'definitely-not-a-build') });
  assert.equal((await get('/')).status, 404);
  // The config is still there, for a site hosted elsewhere.
  assert.equal((await get('/config.js')).status, 200);
});
