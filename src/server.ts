import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { DefaultAzureCredential } from '@azure/identity';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------
type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const suffix =
    extra instanceof Error
      ? ` — ${extra.message}\n${extra.stack}`
      : extra !== undefined
        ? ` — ${JSON.stringify(extra)}`
        : '';
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const app = express();
app.set('trust proxy', 1);
const credential = new DefaultAzureCredential();
const port = Number(process.env.PORT ?? 8080);
const speechEndpoint = process.env.SPEECH_ENDPOINT;
const speechResourceId = process.env.SPEECH_RESOURCE_ID;
const speechRegion = process.env.SPEECH_REGION;
// Each TTS WebSocket session has a hard 600-second limit. At ~750 chars/min
// (150 wpm × 5 chars/word) that means ~7,500 chars max per call. We use
// 4,500 to stay comfortably under the limit; longer articles are split into
// multiple chunks that are synthesised sequentially then concatenated.
const CHUNK_SIZE = 4_500;
const maxCharacters = Number(process.env.MAX_ARTICLE_CHARS ?? 50_000);
const defaultVoice = process.env.DEFAULT_VOICE ?? 'en-US-JennyNeural';
// MP3 format used by both synthesis paths. The string form is the REST
// `X-Microsoft-OutputFormat` header equivalent of the SDK enum
// `Audio16Khz32KBitRateMonoMp3`, so SDK and REST chunks concatenate cleanly.
const REST_OUTPUT_FORMAT = 'audio-16khz-32kbitrate-mono-mp3';
// MAI-Voice-2 is preview and **REST-API only** — it intermittently fails with
// error 1007 over the Speech SDK WebSocket path, so those voices are routed to
// the REST endpoint instead. See AGENTS.md "MAI voices".
const REST_SYNTHESIS_TIMEOUT_MS = 180_000;
// REST retries: the F0 tier can transiently throttle bursts with 400/429/5xx.
const REST_MAX_ATTEMPTS = 3;
const REST_RETRY_BASE_DELAY_MS = 600;

// ---------------------------------------------------------------------------
// Monthly character usage — persisted in Azure Table Storage.
// Falls back to in-memory when AZURE_STORAGE_ACCOUNT_URL is not set.
// ---------------------------------------------------------------------------
const FREE_TIER_CHARS = 500_000;
const USAGE_TABLE = 'usage';
const USAGE_PARTITION = 'usage';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

let tableClient: TableClient | null = null;
if (process.env.AZURE_STORAGE_ACCOUNT_URL) {
  tableClient = new TableClient(process.env.AZURE_STORAGE_ACCOUNT_URL, USAGE_TABLE, credential);
  tableClient.createTable().catch(() => { /* table already exists */ });
  log('info', 'Table Storage connected', { url: process.env.AZURE_STORAGE_ACCOUNT_URL });
}

let memUsage = { month: currentMonth(), chars: 0 };

interface UsageStats { month: string; chars: number; free: number; percent: number }

async function recordUsage(chars: number): Promise<void> {
  const month = currentMonth();
  if (!tableClient) {
    if (memUsage.month !== month) memUsage = { month, chars: 0 };
    memUsage.chars += chars;
    return;
  }
  try {
    let current = 0;
    let etag: string | undefined;
    try {
      const entity = await tableClient.getEntity<{ chars: number }>(USAGE_PARTITION, month);
      current = entity.chars ?? 0;
      etag = entity.etag;
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
    const updated = { partitionKey: USAGE_PARTITION, rowKey: month, chars: current + chars };
    if (etag) {
      await tableClient.updateEntity(updated, 'Replace', { etag });
    } else {
      await tableClient.createEntity(updated);
    }
  } catch (e) {
    log('warn', 'Failed to record usage', e instanceof Error ? e : new Error(String(e)));
  }
}

async function getUsageStats(): Promise<UsageStats> {
  const month = currentMonth();
  if (!tableClient) {
    if (memUsage.month !== month) memUsage = { month, chars: 0 };
    const chars = memUsage.chars;
    return { month, chars, free: FREE_TIER_CHARS, percent: Math.min(100, Math.round(chars / FREE_TIER_CHARS * 100)) };
  }
  try {
    const entity = await tableClient.getEntity<{ chars: number }>(USAGE_PARTITION, month);
    const chars = entity.chars ?? 0;
    return { month, chars, free: FREE_TIER_CHARS, percent: Math.min(100, Math.round(chars / FREE_TIER_CHARS * 100)) };
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 404) {
      return { month, chars: 0, free: FREE_TIER_CHARS, percent: 0 };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Audio recordings — persisted in Azure Blob Storage (container: recordings).
// ---------------------------------------------------------------------------
const RECORDINGS_CONTAINER = 'recordings';
let recordingsContainer: ContainerClient | null = null;

if (process.env.AZURE_STORAGE_BLOB_URL) {
  const blobService = new BlobServiceClient(process.env.AZURE_STORAGE_BLOB_URL, credential);
  recordingsContainer = blobService.getContainerClient(RECORDINGS_CONTAINER);
  recordingsContainer
    .createIfNotExists()
    .then(() => log('info', 'Blob recordings container ready'))
    .catch((e: unknown) => log('warn', 'Could not create recordings container', e instanceof Error ? e : new Error(String(e))));
}

interface RecordingMeta {
  name: string;
  title: string;
  voice: string;
  chars: number;
  chunks: number;
  articleUrl: string;
  createdAt: string;
  sizeBytes: number;
}

function makeSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'article';
}

function makeBlobName(title: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // "2026-06-04T21-00-00"
  return `${ts}-${makeSlug(title)}.mp3`;
}

async function uploadRecording(
  audio: Buffer,
  blobName: string,
  meta: Pick<RecordingMeta, 'title' | 'voice' | 'chars' | 'chunks' | 'articleUrl'>
): Promise<void> {
  if (!recordingsContainer) return;
  try {
    const blockBlob = recordingsContainer.getBlockBlobClient(blobName);
    await blockBlob.upload(audio, audio.length, {
      blobHTTPHeaders: { blobContentType: 'audio/mpeg' },
      metadata: {
        title: meta.title.slice(0, 512),
        voice: meta.voice,
        chars: String(meta.chars),
        chunks: String(meta.chunks),
        articleurl: meta.articleUrl.slice(0, 512)
      }
    });
    log('info', 'Recording uploaded', { blobName, chars: meta.chars, bytes: audio.length });
  } catch (e) {
    log('warn', 'Failed to upload recording', e instanceof Error ? e : new Error(String(e)));
  }
}

const fetchTimeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? 20_000);

// A browser-like User-Agent and Accept headers reduce the chance that sites
// stall, block, or serve a degraded response to the fetch, which previously
// surfaced as 504 "Timed out fetching article" errors.
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36 article-to-speech-app/1.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, 'public');

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.azure.internal']);

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function isBlockedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (
    normalized === '::' ||
    normalized === '::1' ||
    /^(fc|fd)[0-9a-f]{0,2}:/u.test(normalized) ||
    /^fe[89ab][0-9a-f]:/u.test(normalized)
  ) {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    return isBlockedIp(normalized.slice(7));
  }

  if (!net.isIPv4(normalized)) {
    return false;
  }

  const octets = normalized.split('.').map(Number);
  const [a, b] = octets;

  if (normalized === '0.0.0.0') {
    return true;
  }

  if (a === 10 || a === 127) {
    return true;
  }

  if (a === 169 && b === 254) {
    return true;
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  if (a === 192 && b === 168) {
    return true;
  }

  return false;
}

async function validateExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, 'Only http/https URLs are allowed');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || BLOCKED_HOSTS.has(hostname)) {
    throw new HttpError(400, 'URL host is not allowed');
  }

  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    throw new HttpError(400, 'URL resolves to a private or local IP');
  }

  const records = await dns.lookup(hostname, { all: true });
  if (records.some((record) => isBlockedIp(record.address))) {
    throw new HttpError(400, 'URL resolves to a private or local IP');
  }

  return parsed;
}

async function fetchArticleHtml(initialUrl: URL): Promise<{ html: string; finalUrl: URL }> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const safeUrl = await validateExternalUrl(currentUrl.toString());
    let response: globalThis.Response;
    try {
      response = await fetch(safeUrl, {
        redirect: 'manual',
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new HttpError(504, 'Timed out fetching the article (the site took too long to respond)');
      }
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new HttpError(502, 'Article URL redirect is missing location');
      }
      const redirectedUrl = new URL(location, safeUrl);
      currentUrl = await validateExternalUrl(redirectedUrl.toString());
      continue;
    }

    if (!response.ok) {
      throw new HttpError(502, `Failed to fetch article (${response.status})`);
    }

    return { html: await response.text(), finalUrl: safeUrl };
  }

  throw new HttpError(502, 'Too many redirects');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanArticleText(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, maxCharacters);
}

// Split text into chunks at sentence boundaries so each TTS call is within
// the Azure 600-second WebSocket session limit (CHUNK_SIZE chars ≈ 6 min).
function splitIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.slice(0, CHUNK_SIZE);
    // Prefer splitting at the last sentence-ending punctuation followed by a space.
    const sentenceEnd = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('.\n'),
      slice.lastIndexOf('!\n'),
      slice.lastIndexOf('?\n')
    );
    // Fall back to last space if no sentence boundary found in the latter half.
    const splitAt =
      sentenceEnd > CHUNK_SIZE * 0.5
        ? sentenceEnd + 1
        : (slice.lastIndexOf(' ') > 0 ? slice.lastIndexOf(' ') : CHUNK_SIZE);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
}

function pickVoice(voice?: string, language?: string): string {
  if (voice?.trim()) {
    return voice.trim();
  }
  return defaultVoice;
}

async function createSpeechConfig(): Promise<sdk.SpeechConfig> {
  if (!speechEndpoint || !speechResourceId || !speechRegion) {
    throw new Error('SPEECH_ENDPOINT, SPEECH_RESOURCE_ID and SPEECH_REGION must be configured');
  }

  const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!token?.token) {
    throw new Error('Could not acquire Azure AI Speech access token');
  }

  // For SpeechSynthesizer, MS docs require fromAuthorizationToken(aad#resourceId#token, region).
  // The fromEndpoint approach only works for recognizers. The aad# prefix tells the regional
  // TTS endpoint which Speech resource to authenticate against.
  const authorizationToken = `aad#${speechResourceId}#${token.token}`;
  return sdk.SpeechConfig.fromAuthorizationToken(authorizationToken, speechRegion);
}

async function synthesizeSpeech(
  text: string,
  voiceName: string,
  onProgress?: (fraction: number) => void
): Promise<Buffer> {
  if (isRestOnlyVoice(voiceName)) {
    return synthesizeSpeechRest(text, voiceName);
  }
  return synthesizeSpeechSdk(text, voiceName, onProgress);
}

// MAI-Voice-2 voices (e.g. `en-US-Harper:MAI-Voice-2`) are REST-only.
function isRestOnlyVoice(voiceName: string): boolean {
  return /:MAI-Voice-2$/i.test(voiceName.trim());
}

// Derives the BCP-47 locale (e.g. `es-MX`) from a voice id like
// `es-MX-Valeria:MAI-Voice-2`, used for the SSML `xml:lang` attribute so
// multilingual voices render in the correct language. Falls back to `en-US`.
function voiceLocale(voiceName: string): string {
  const match = voiceName.trim().match(/^([a-z]{2,3}-[A-Za-z0-9]+)/);
  return match ? match[1] : 'en-US';
}

// REST synthesis path for voices that aren't supported over the SDK WebSocket
// (currently MAI-Voice-2). Sends SSML to the regional cognitiveservices/v1
// endpoint authenticated with a Microsoft Entra token in the Speech-specific
// `aad#<resourceId>#<token>` form (plain bearer is rejected with 401).
//
// The F0 (free) tier rate-limits bursts and can transiently answer with 400/429
// even for valid voices, so failures are retried with backoff. A 400 that
// persists across all attempts is treated as an unavailable voice (HTTP 422).
async function synthesizeSpeechRest(text: string, voiceName: string): Promise<Buffer> {
  if (!speechResourceId || !speechRegion) {
    throw new Error('SPEECH_RESOURCE_ID and SPEECH_REGION must be configured');
  }

  const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!token?.token) {
    throw new Error('Could not acquire Azure AI Speech access token');
  }

  const url = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const locale = voiceLocale(voiceName);
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${escapeXml(locale)}">` +
    `<voice name="${escapeXml(voiceName)}">${escapeXml(text)}</voice></speak>`;

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= REST_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REST_SYNTHESIS_TIMEOUT_MS);
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': REST_OUTPUT_FORMAT,
          Authorization: `Bearer aad#${speechResourceId}#${token.token}`,
          'User-Agent': 'article-to-speech'
        },
        body: ssml,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Speech synthesis timed out after ${REST_SYNTHESIS_TIMEOUT_MS}ms`);
      }
      throw new Error(`Speech synthesis request failed: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    lastStatus = response.status;
    lastBody = await response.text().catch(() => '');

    // Retry transient throttling/server errors (and 400, which the F0 tier can
    // emit under burst load) until attempts are exhausted.
    const retryable = response.status === 400 || response.status === 429 || response.status >= 500;
    if (retryable && attempt < REST_MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : REST_RETRY_BASE_DELAY_MS * attempt;
      log('warn', 'REST synthesis retry', { voiceName, attempt, status: response.status, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    break;
  }

  // A persistent 400 mirrors SDK error 1007 (unknown/unsupported voice) — surface
  // it as a friendly 422 like the SDK path does.
  if (lastStatus === 400) {
    throw new HttpError(
      422,
      `Voice "${voiceName}" is not available in this region. Please choose a different voice.`
    );
  }
  throw new Error(`Speech synthesis failed (HTTP ${lastStatus}): ${lastBody.slice(0, 200)}`);
}

async function synthesizeSpeechSdk(
  text: string,
  voiceName: string,
  onProgress?: (fraction: number) => void
): Promise<Buffer> {
  const speechConfig = await createSpeechConfig();
  speechConfig.speechSynthesisVoiceName = voiceName;
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${escapeXml(voiceName)}">${escapeXml(text)}</voice></speak>`;
  const textLength = text.length;

  return new Promise((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    if (onProgress && textLength > 0) {
      synthesizer.wordBoundary = (_sender, event) => {
        const consumed = event.textOffset + event.wordLength;
        const fraction = Math.min(1, Math.max(0, consumed / textLength));
        onProgress(fraction);
      };
    }

    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(Buffer.from(result.audioData));
        } else {
          const details = result.errorDetails ?? 'Speech synthesis failed';
          // Give a user-friendly message for the most common failures.
          if (details.includes('Unsupported voice') || details.includes('1007')) {
            reject(new HttpError(422, `Voice "${voiceName}" is not available in this region. Please choose a different voice.`));
          } else {
            reject(new Error(details));
          }
        }
        synthesizer.close();
      },
      (error) => {
        synthesizer.close();
        reject(new Error(String(error)));
      }
    );
  });
}

const readLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false
});

const previewLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

const staticLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({ limit: '256kb' }));
app.use(staticLimiter, express.static(publicDir));

// Request logger — logs method, path, status and duration for every request.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    log('info', `${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/me', (req: Request, res: Response) => {
  res.json({
    principalId: req.header('x-ms-client-principal-id') ?? null,
    principalName: req.header('x-ms-client-principal-name') ?? null,
    principalIdp: req.header('x-ms-client-principal-idp') ?? null
  });
});

app.get('/api/usage', async (_req: Request, res: Response) => {
  try {
    res.json(await getUsageStats());
  } catch (e) {
    log('error', '/api/usage error', e instanceof Error ? e : new Error(String(e)));
    res.json({ month: currentMonth(), chars: 0, free: FREE_TIER_CHARS, percent: 0 });
  }
});

// ---------------------------------------------------------------------------
// Recordings API
// ---------------------------------------------------------------------------

const recordingsLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

app.get('/api/recordings', recordingsLimiter, async (_req: Request, res: Response) => {
  if (!recordingsContainer) {
    res.json([]);
    return;
  }
  try {
    const items: RecordingMeta[] = [];
    for await (const blob of recordingsContainer.listBlobsFlat({ includeMetadata: true })) {
      const m = blob.metadata ?? {};
      items.push({
        name: blob.name,
        title: m['title'] ?? blob.name,
        voice: m['voice'] ?? '',
        chars: Number(m['chars'] ?? 0),
        chunks: Number(m['chunks'] ?? 1),
        articleUrl: m['articleurl'] ?? '',
        createdAt: blob.properties.createdOn?.toISOString() ?? '',
        sizeBytes: blob.properties.contentLength ?? 0
      });
    }
    // Newest first
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(items);
  } catch (e) {
    log('error', '/api/recordings list error', e instanceof Error ? e : new Error(String(e)));
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

app.get('/api/recordings/:name/audio', recordingsLimiter, async (req: Request, res: Response) => {
  const { name } = req.params;
  // Sanitize: only allow safe blob names (no path traversal)
  if (!name || !/^[\w\-]+\.mp3$/.test(name)) {
    res.status(400).json({ error: 'Invalid recording name' });
    return;
  }
  if (!recordingsContainer) {
    res.status(503).json({ error: 'Storage not configured' });
    return;
  }
  try {
    const blobClient = recordingsContainer.getBlobClient(name);
    const props = await blobClient.getProperties();
    const download = await blobClient.download();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(props.contentLength ?? 0));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    download.readableStreamBody?.pipe(res);
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 404) {
      res.status(404).json({ error: 'Recording not found' });
    } else {
      log('error', `/api/recordings/${name}/audio error`, e instanceof Error ? e : new Error(String(e)));
      res.status(500).json({ error: 'Failed to stream recording' });
    }
  }
});

app.delete('/api/recordings/:name', recordingsLimiter, async (req: Request, res: Response) => {
  const { name } = req.params;
  if (!name || !/^[\w\-]+\.mp3$/.test(name)) {
    res.status(400).json({ error: 'Invalid recording name' });
    return;
  }
  if (!recordingsContainer) {
    res.status(503).json({ error: 'Storage not configured' });
    return;
  }
  try {
    await recordingsContainer.getBlobClient(name).delete();
    log('info', 'Recording deleted', { name });
    res.json({ ok: true });
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 404) {
      res.status(404).json({ error: 'Recording not found' });
    } else {
      log('error', `DELETE /api/recordings/${name} error`, e instanceof Error ? e : new Error(String(e)));
      res.status(500).json({ error: 'Failed to delete recording' });
    }
  }
});

interface PreviewResult {
  chars: number;
  truncated: boolean;
  title: string | null;
}

app.post('/api/preview', previewLimiter, async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  try {
    const parsedUrl = await validateExternalUrl(url);
    const { html, finalUrl } = await fetchArticleHtml(parsedUrl);
    const dom = new JSDOM(html, { url: finalUrl.toString() });
    const article = new Readability(dom.window.document).parse();
    const rawText = (article?.textContent ?? '').replace(/\s+/g, ' ').trim();
    res.json({
      chars: Math.min(rawText.length, maxCharacters),
      truncated: rawText.length > maxCharacters,
      title: article?.title ?? null
    } satisfies PreviewResult);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    log('error', '/api/preview error', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ error: 'Internal server error' });
  }
});

type ProgressStage = 'validating' | 'fetching' | 'extracting' | 'synthesizing' | 'done';

interface ProgressEvent {
  stage: ProgressStage;
  progress: number;
  message: string;
}

const STAGE_RANGES: Record<Exclude<ProgressStage, 'done'>, [number, number]> = {
  validating: [0, 0.05],
  fetching: [0.05, 0.2],
  extracting: [0.2, 0.25],
  synthesizing: [0.25, 0.95]
};

function stageProgress(stage: Exclude<ProgressStage, 'done'>, fraction = 0): number {
  const [start, end] = STAGE_RANGES[stage];
  const clamped = Math.min(1, Math.max(0, fraction));
  return Number((start + (end - start) * clamped).toFixed(4));
}

const MIN_PROGRESS_DELTA = 0.01;

interface ReadRequest {
  url?: string;
  voice?: string;
  language?: string;
}

async function generateArticleAudio(
  { url, voice, language }: ReadRequest,
  onProgress: (event: ProgressEvent) => void
): Promise<{ audio: Buffer; recordingName: string | null }> {
  if (!url) throw new HttpError(400, 'url is required');

  onProgress({ stage: 'validating', progress: stageProgress('validating'), message: 'Checking the URL…' });
  const parsedUrl = await validateExternalUrl(url);

  onProgress({ stage: 'fetching', progress: stageProgress('fetching'), message: 'Fetching the article…' });
  const { html, finalUrl } = await fetchArticleHtml(parsedUrl);

  onProgress({ stage: 'extracting', progress: stageProgress('extracting'), message: 'Extracting readable text…' });
  const dom = new JSDOM(html, { url: finalUrl.toString() });
  const article = new Readability(dom.window.document).parse();
  const title = article?.title ?? 'Untitled article';
  const text = cleanArticleText(article?.textContent ?? '');
  if (!text) throw new HttpError(422, 'Could not extract readable article text');

  const selectedVoice = pickVoice(voice, language);
  const chunks = splitIntoChunks(text);
  log('info', 'Starting synthesis', { url, title, chars: text.length, chunks: chunks.length, voice: selectedVoice });

  const audioParts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkMsg = chunks.length > 1
      ? `Converting to speech (chunk ${i + 1} of ${chunks.length})…`
      : 'Converting text to speech…';
    onProgress({ stage: 'synthesizing', progress: stageProgress('synthesizing', i / chunks.length), message: chunkMsg });

    const part = await synthesizeSpeech(chunks[i], selectedVoice, (fraction) => {
      const overall = (i + fraction) / chunks.length;
      onProgress({ stage: 'synthesizing', progress: stageProgress('synthesizing', overall), message: chunkMsg });
    });
    audioParts.push(part);
    log('info', `Chunk ${i + 1}/${chunks.length} done`, { chars: chunks[i].length, bytes: part.length });
  }

  const audio = audioParts.length === 1 ? audioParts[0] : Buffer.concat(audioParts);
  log('info', 'Synthesis complete', { chars: text.length, chunks: chunks.length, totalBytes: audio.length });

  await recordUsage(text.length);

  // Upload to blob storage (non-blocking — failure is logged but doesn't break the response).
  const blobName = makeBlobName(title);
  await uploadRecording(audio, blobName, { title, voice: selectedVoice, chars: text.length, chunks: chunks.length, articleUrl: url });

  return { audio, recordingName: recordingsContainer ? blobName : null };
}

app.post('/api/read', readLimiter, async (req: Request, res: Response) => {
  const wantsStream = (req.header('accept') ?? '').includes('text/event-stream');
  const body = req.body as ReadRequest;

  if (!wantsStream) {
    try {
      const { audio } = await generateArticleAudio(body, () => {});
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(audio);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      log('error', '/api/read error', error instanceof Error ? error : new Error(String(error)));
      res.status(500).json({ error: 'Internal server error' });
    }
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let lastProgress = -1;

  try {
    const { audio, recordingName } = await generateArticleAudio(body, (event) => {
      if (event.progress - lastProgress < MIN_PROGRESS_DELTA && event.stage === 'synthesizing') return;
      lastProgress = event.progress;
      send('progress', event);
    });

    send('progress', { stage: 'done', progress: 1, message: 'Done.' });
    send('audio', { contentType: 'audio/mpeg', audio: audio.toString('base64'), recordingName });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError ? error.message : 'Internal server error';
    if (!(error instanceof HttpError)) {
      log('error', '/api/read SSE error', error instanceof Error ? error : new Error(String(error)));
    }
    send('error', { statusCode, error: message });
  } finally {
    res.end();
  }
});

app.get('*', staticLimiter, (_req: Request, res: Response) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

app.listen(port, () => {
  log('info', `listening on port ${port}`);
});
