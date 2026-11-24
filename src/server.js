import express from 'express';
import helmet from 'helmet';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
const allowedHosts = (process.env.ALLOWED_HOSTS || 'tiktok.com,instagram.com,facebook.com,fb.watch,twitter.com,x.com,pinterest.com,pin.it,reddit.com,redd.it,threads.net')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 8);
const rateWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const requests = new Map();
const dirname = path.dirname(fileURLToPath(import.meta.url));

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(dirname, '..', 'public')));

function keyFor(req) {
  return process.env.TRUST_PROXY === '1'
    ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown';
}
function limit(req, res, next) {
  const now = Date.now();
  const key = keyFor(req);
  const recent = (requests.get(key) || []).filter(t => now - t < rateWindowMs);
  if (recent.length >= rateLimitMax) {
    res.set('Retry-After', String(Math.ceil(rateWindowMs / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  }
  recent.push(now);
  requests.set(key, recent);
  next();
}
function validateUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Please enter a valid video link.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS links are supported.');
  if (parsed.username || parsed.password) throw new Error('Links containing credentials are not allowed.');
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!allowedHosts.some(domain => host === domain || host.endsWith('.' + domain))) {
    throw new Error('This platform is not enabled yet.');
  }
  return parsed.toString();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'MR Downloader' }));

app.post('/api/download', limit, async (req, res) => {
  let url;
  try { url = validateUrl(req.body?.url); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  let tempDir;
  let child;
  let timedOut = false;
  const cleanupTemp = async () => {
    if (tempDir) {
      const dir = tempDir;
      tempDir = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mr-downloader-'));
    const outputPath = path.join(tempDir, 'video.mov');
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames',
      '--format', 'bestvideo*+bestaudio/best',
      '--merge-output-format', 'mov', '--remux-video', 'mov',
      '--output', outputPath,
      '--', url
    ];

    child = spawn(ytdlp, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => {
      if (stderr.length < 12000) stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Number(process.env.DOWNLOAD_TIMEOUT_MS || 180000));

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
      res.once('close', () => {
        if (!res.writableEnded && child && child.exitCode === null) child.kill('SIGTERM');
      });
    }).finally(() => clearTimeout(timeout));

    if (res.destroyed) { await cleanupTemp(); return; }
    if (timedOut) { await cleanupTemp(); return res.status(504).json({ error: 'The download took too long. Please try again.' }); }
    if (exitCode !== 0) {
      await cleanupTemp();
      const needsLogin = /private|login|sign in|authentication/i.test(stderr);
      return res.status(422).json({ error: needsLogin
        ? 'This link may require login or may not be publicly accessible.'
        : 'Could not download this link. It may be unavailable or unsupported.' });
    }

    const info = await stat(outputPath);
    if (!info.isFile() || info.size === 0) {
      await cleanupTemp();
      return res.status(422).json({ error: 'The source did not return a playable video.' });
    }

    res.status(200).set({
      'Content-Type': 'video/quicktime',
      'Content-Disposition': 'attachment; filename="mr-downloader-video.mov"',
      'Content-Length': String(info.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });

    const cleanup = () => {
      if (tempDir) rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = null;
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    createReadStream(outputPath).pipe(res);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      res.status(503).json({ error: 'Download service could not complete the request. Please try again.' });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((error, _req, res, _next) => {
  if (!res.headersSent) res.status(500).json({ error: 'Unexpected server error.' });
  else res.destroy(error);
});

app.listen(port, '0.0.0.0', () => console.log(`MR Downloader listening on :${port}`));
