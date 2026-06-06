#!/usr/bin/env node
// Smoke test against the LIVE, Entra-protected (Easy Auth) deployment.
//
// It authenticates as the *current az-logged-in user* by minting a v2 access
// token for the auth app (which pre-authorizes the Azure CLI), then exercises
// the protected API. It also confirms that unauthenticated requests are still
// redirected to login, so the test doubles as an "auth is intact" check.
//
// Usage:
//   az login
//   npm run test:live
//
// Optional environment overrides:
//   APP_BASE_URL          Base URL of the deployment (default: live FQDN below).
//   AUTH_APP_CLIENT_ID    Auth app (Easy Auth) client id. Auto-discovered via az
//                         from the Container App if not set.
//   RESOURCE_GROUP        Resource group for auto-discovery (default rg-test-repo).
//   CONTAINER_APP         Container App name for auto-discovery (default ca-articletts).
//   SMOKE_TEST_READ=1     Also run a (billable) POST /api/read TTS synthesis.
//   SMOKE_TEST_VOICE      Voice for the read test (default en-US-Harper:MAI-Voice-2).
//   SMOKE_TEST_URL        Article URL for the read/preview tests (default example.com).

import { execFileSync } from 'node:child_process';

const BASE_URL = (process.env.APP_BASE_URL ??
  'https://ca-articletts.kindcliff-7e76e63c.norwayeast.azurecontainerapps.io').replace(/\/$/, '');
const RESOURCE_GROUP = process.env.RESOURCE_GROUP ?? 'rg-test-repo';
const CONTAINER_APP = process.env.CONTAINER_APP ?? 'ca-articletts';
const ARTICLE_URL = process.env.SMOKE_TEST_URL ?? 'https://example.com';
const READ_VOICE = process.env.SMOKE_TEST_VOICE ?? 'en-US-Harper:MAI-Voice-2';
const isWindows = process.platform === 'win32';

let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  failed++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Run the Azure CLI. `az` is a batch file on Windows, so it must be invoked via
// the shell there; execFileSync with shell handles quoting of our simple args.
function az(args) {
  return execFileSync(isWindows ? 'az.cmd' : 'az', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows
  }).trim();
}

function discoverClientId() {
  if (process.env.AUTH_APP_CLIENT_ID) return process.env.AUTH_APP_CLIENT_ID;
  console.log('Discovering auth app client id from the Container App…');
  return az([
    'containerapp', 'auth', 'show',
    '-g', RESOURCE_GROUP,
    '-n', CONTAINER_APP,
    '--query', 'identityProviders.azureActiveDirectory.registration.clientId',
    '-o', 'tsv'
  ]);
}

function acquireToken(clientId) {
  console.log(`Acquiring access token for ${clientId} via az…`);
  return az([
    'account', 'get-access-token',
    '--scope', `${clientId}/.default`,
    '--query', 'accessToken',
    '-o', 'tsv'
  ]);
}

async function main() {
  console.log(`Live smoke test → ${BASE_URL}\n`);

  // 1. Health endpoint is unauthenticated and must always work.
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body.ok === true) ok('GET /health', 'ok:true');
    else fail('GET /health', `status ${res.status} body ${JSON.stringify(body)}`);
  } catch (err) {
    fail('GET /health', String(err));
  }

  // 2. Unauthenticated request to a protected page must be redirected to login
  //    (proves Easy Auth is still enforced after the infra change).
  try {
    const res = await fetch(`${BASE_URL}/`, { redirect: 'manual' });
    if (res.status === 302 || res.status === 401) {
      ok('GET / (no token) redirected', `status ${res.status}`);
    } else {
      fail('GET / (no token) redirected', `expected 302/401, got ${res.status}`);
    }
  } catch (err) {
    fail('GET / (no token) redirected', String(err));
  }

  // Acquire a token as the current user.
  let token;
  try {
    const clientId = discoverClientId();
    if (!clientId) throw new Error('could not determine auth app client id');
    token = acquireToken(clientId);
    if (!token) throw new Error('empty token');
    ok('Acquire user token via az', `${token.length} chars`);
  } catch (err) {
    fail('Acquire user token via az', String(err).split('\n')[0]);
    console.log('\nCannot continue authenticated checks without a token.');
    summarize();
    return;
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  // 3. /api/me must return the caller identity from the Easy Auth headers.
  try {
    const res = await fetch(`${BASE_URL}/api/me`, { headers: authHeaders });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200) {
      const who = body.principalName || body.principalId || JSON.stringify(body);
      ok('GET /api/me (token)', `identity: ${who}`);
    } else {
      fail('GET /api/me (token)', `status ${res.status} ${JSON.stringify(body)}`);
    }
  } catch (err) {
    fail('GET /api/me (token)', String(err));
  }

  // 4. /api/preview must extract the article (no TTS, no cost).
  try {
    const res = await fetch(`${BASE_URL}/api/preview`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: ARTICLE_URL })
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && typeof body.chars === 'number') {
      ok('POST /api/preview (token)', `chars: ${body.chars}, title: ${body.title ?? ''}`);
    } else {
      fail('POST /api/preview (token)', `status ${res.status} ${JSON.stringify(body)}`);
    }
  } catch (err) {
    fail('POST /api/preview (token)', String(err));
  }

  // 5. Optional billable end-to-end TTS via the default MAI-Voice-2 voice.
  if (process.env.SMOKE_TEST_READ === '1') {
    try {
      const res = await fetch(`${BASE_URL}/api/read`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ARTICLE_URL, voice: READ_VOICE, language: READ_VOICE.split('-')[0] })
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (res.status === 200 && contentType.includes('audio/mpeg')) {
        const bytes = (await res.arrayBuffer()).byteLength;
        ok('POST /api/read (token)', `${READ_VOICE} → ${bytes} bytes`);
      } else {
        const body = await res.text().catch(() => '');
        fail('POST /api/read (token)', `status ${res.status} ${body.slice(0, 160)}`);
      }
    } catch (err) {
      fail('POST /api/read (token)', String(err));
    }
  } else {
    console.log('  SKIP  POST /api/read (set SMOKE_TEST_READ=1 to run the billable TTS test)');
  }

  summarize();
}

function summarize() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
