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
const fetchTimeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? 10_000);

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
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) {
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
        headers: { 'User-Agent': 'article-to-speech-app/1.0' },
        signal: AbortSignal.timeout(fetchTimeoutMs)
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new HttpError(504, 'Timed out fetching article');
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

async function synthesizeSpeech(text: string, voiceName: string): Promise<Buffer> {
  const speechConfig = await createSpeechConfig();
  speechConfig.speechSynthesisVoiceName = voiceName;
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${escapeXml(voiceName)}">${escapeXml(text)}</voice></speak>`;

  return new Promise((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
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
app.use(staticLimiter, express.static(publicDir, { index: false }));

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

app.post('/api/read', readLimiter, async (req: Request, res: Response) => {
  try {
    const { url, voice, language } = req.body as { url?: string; voice?: string; language?: string };
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    const parsedUrl = await validateExternalUrl(url);
    const { html, finalUrl } = await fetchArticleHtml(parsedUrl);
    const dom = new JSDOM(html, { url: finalUrl.toString() });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const text = cleanArticleText(article?.textContent ?? '');
    if (!text) {
      res.status(422).json({ error: 'Could not extract readable article text' });
      return;
    }

    const audio = await synthesizeSpeech(text, pickVoice(voice, language));
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('*', staticLimiter, (_req: Request, res: Response) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
