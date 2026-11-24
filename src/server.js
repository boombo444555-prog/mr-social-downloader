import express from 'express';
import helmet from 'helmet';
import { spawn } from 'node:child_process';
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
  // Enable only behind a reverse proxy you control.
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
  if (!allowedHosts.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('This platform is not enabled yet.');
  }
  return parsed.toString();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'MR Downloader' }));

app.post('/api/download', limit, (req, res) => {
  let url;
  try { url = validateUrl(req.body?.url); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const args = ['--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames',
    '--format', 'best[ext=mp4]/best', '--output', '-', '--', url];
  const child = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let started = false;
  let closed = false;
  const timeout = setTimeout(() => child.kill('SIGKILL'), Number(process.env.DOWNLOAD_TIMEOUT_MS || 180000));

  child.stderr.on('data', chunk => { if (stderr.length < 12000) stderr += chunk.toString(); });
  child.once('error', error => {
    clearTimeout(timeout);
    if (!res.headersSent) res.status(503).json({ error: 'Download engine is unavailable. Please try again later.' });
    else res.destroy(error);
  });
  child.stdout.once('data', () => {
    started = true;
    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="mr-downloader-video.mp4"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
  });
  child.stdout.on('data', chunk => { if (!res.destroyed) res.write(chunk); });
  child.stdout.on('end', () => { if (!res.destroyed) res.end(); });
  child.on('close', code => {
    closed = true;
    clearTimeout(timeout);
    if (!started && !res.headersSent) {
      const needsLogin = /private|login|sign in|authentication/i.test(stderr);
      res.status(422).json({ error: needsLogin
        ? 'This link may require login or may not be publicly accessible.'
        : 'Could not download this link. It may be unavailable or unsupported.' });
    } else if (code !== 0 && !res.destroyed) {
      res.destroy(new Error('Download process failed.'));
    }
  });
  res.on('close', () => {
    if (!closed) child.kill('SIGTERM');
    clearTimeout(timeout);
  });
});

app.use((error, _req, res, _next) => {
  if (!res.headersSent) res.status(500).json({ error: 'Unexpected server error.' });
  else res.destroy(error);
});

app.listen(port, '0.0.0.0', () => console.log(`MR Downloader listening on :${port}`));
