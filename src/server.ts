import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { DefaultAzureCredential } from '@azure/identity';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.set('trust proxy', 1);
const credential = new DefaultAzureCredential();
const port = Number(process.env.PORT ?? 8080);
const speechEndpoint = process.env.SPEECH_ENDPOINT;
const speechResourceId = process.env.SPEECH_RESOURCE_ID;
const maxCharacters = Number(process.env.MAX_ARTICLE_CHARS ?? 12000);
const defaultVoice = process.env.DEFAULT_VOICE ?? 'en-US-JennyNeural';
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

function pickVoice(voice?: string, language?: string): string {
  if (voice?.trim()) {
    return voice.trim();
  }
  if (language?.startsWith('nb')) {
    return 'nb-NO-PernilleNeural';
  }
  return defaultVoice;
}

async function createSpeechConfig(): Promise<sdk.SpeechConfig> {
  if (!speechEndpoint || !speechResourceId) {
    throw new Error('SPEECH_ENDPOINT and SPEECH_RESOURCE_ID must be configured');
  }

  const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!token?.token) {
    throw new Error('Could not acquire Azure AI Speech access token');
  }

  const authorizationToken = `aad#${speechResourceId}#${token.token}`;
  return sdk.SpeechConfig.fromAuthorizationToken(authorizationToken, speechEndpoint);
}

async function synthesizeSpeech(
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
          reject(new Error(result.errorDetails || 'Speech synthesis failed'));
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

const staticLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({ limit: '256kb' }));
app.use(staticLimiter, express.static(publicDir));

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

type ProgressStage = 'validating' | 'fetching' | 'extracting' | 'synthesizing' | 'done';

interface ProgressEvent {
  stage: ProgressStage;
  progress: number;
  message: string;
}

// Overall progress is split into weighted phases so the client can render a
// single smooth progress bar across the whole article-to-speech pipeline.
const STAGE_RANGES: Record<Exclude<ProgressStage, 'done'>, [number, number]> = {
  validating: [0, 0.1],
  fetching: [0.1, 0.35],
  extracting: [0.35, 0.45],
  synthesizing: [0.45, 1]
};

function stageProgress(stage: Exclude<ProgressStage, 'done'>, fraction = 0): number {
  const [start, end] = STAGE_RANGES[stage];
  const clamped = Math.min(1, Math.max(0, fraction));
  return Number((start + (end - start) * clamped).toFixed(4));
}

interface ReadRequest {
  url?: string;
  voice?: string;
  language?: string;
}

async function generateArticleAudio(
  { url, voice, language }: ReadRequest,
  onProgress: (event: ProgressEvent) => void
): Promise<Buffer> {
  if (!url) {
    throw new HttpError(400, 'url is required');
  }

  onProgress({ stage: 'validating', progress: stageProgress('validating'), message: 'Checking the URL…' });
  const parsedUrl = await validateExternalUrl(url);

  onProgress({ stage: 'fetching', progress: stageProgress('fetching'), message: 'Fetching the article…' });
  const { html, finalUrl } = await fetchArticleHtml(parsedUrl);

  onProgress({ stage: 'extracting', progress: stageProgress('extracting'), message: 'Extracting readable text…' });
  const dom = new JSDOM(html, { url: finalUrl.toString() });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const text = cleanArticleText(article?.textContent ?? '');
  if (!text) {
    throw new HttpError(422, 'Could not extract readable article text');
  }

  onProgress({ stage: 'synthesizing', progress: stageProgress('synthesizing'), message: 'Converting text to speech…' });
  const audio = await synthesizeSpeech(text, pickVoice(voice, language), (fraction) => {
    onProgress({
      stage: 'synthesizing',
      progress: stageProgress('synthesizing', fraction),
      message: 'Converting text to speech…'
    });
  });

  return audio;
}

app.post('/api/read', readLimiter, async (req: Request, res: Response) => {
  const wantsStream = (req.header('accept') ?? '').includes('text/event-stream');
  const body = req.body as ReadRequest;

  if (!wantsStream) {
    try {
      const audio = await generateArticleAudio(body, () => {});
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(audio);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
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
    const audio = await generateArticleAudio(body, (event) => {
      // Avoid flooding the stream with tiny, indistinguishable updates.
      if (event.progress - lastProgress < 0.01 && event.stage === 'synthesizing') {
        return;
      }
      lastProgress = event.progress;
      send('progress', event);
    });

    send('progress', { stage: 'done', progress: 1, message: 'Done.' });
    send('audio', { contentType: 'audio/mpeg', audio: audio.toString('base64') });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message =
      error instanceof HttpError ? error.message : 'Internal server error';
    send('error', { statusCode, error: message });
  } finally {
    res.end();
  }
});

app.get('*', staticLimiter, (_req: Request, res: Response) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
