import express from 'express';
import helmet from 'helmet';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
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
  const cleanupTemp = async () => {
    if (tempDir) {
      const dir = tempDir;
      tempDir = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  // Run yt-dlp and FFmpeg with a timeout, while stopping work if the client disconnects.
  const runProcess = (command, args, timeoutMs) => new Promise((resolve, reject) => {
    let stderr = '';
    let timedOut = false;
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child = proc;
    proc.stderr.on('data', chunk => {
      if (stderr.length < 12000) stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);
    const onResponseClose = () => {
      if (!res.writableEnded && proc.exitCode === null) proc.kill('SIGTERM');
    };
    res.once('close', onResponseClose);
    proc.once('error', error => {
      clearTimeout(timeout);
      res.off('close', onResponseClose);
      if (child === proc) child = null;
      reject(error);
    });
    proc.once('close', code => {
      clearTimeout(timeout);
      res.off('close', onResponseClose);
      if (child === proc) child = null;
      resolve({ code, stderr, timedOut });
    });
  });

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'mr-downloader-'));
    const sourceTemplate = path.join(tempDir, 'source.%(ext)s');
    const outputPath = path.join(tempDir, 'video.mp4');
    const downloadTimeout = Number(process.env.DOWNLOAD_TIMEOUT_MS || 180000);
    const transcodeTimeout = Number(process.env.TRANSCODE_TIMEOUT_MS || 300000);

    const download = await runProcess(ytdlp, [
      '--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames',
      '--format', 'bestvideo*+bestaudio/best',
      '--merge-output-format', 'mkv',
      '--output', sourceTemplate,
      '--', url
    ], downloadTimeout);

    if (res.destroyed) { await cleanupTemp(); return; }
    if (download.timedOut) {
      await cleanupTemp();
      return res.status(504).json({ error: 'The download took too long. Please try again.' });
    }
    if (download.code !== 0) {
      await cleanupTemp();
      const needsLogin = /private|login|sign in|authentication/i.test(download.stderr);
      return res.status(422).json({ error: needsLogin
        ? 'This link may require login or may not be publicly accessible.'
        : 'Could not download this link. It may be unavailable or unsupported.' });
    }

    const files = await readdir(tempDir, { withFileTypes: true });
    const sourceFile = files.find(entry =>
      entry.isFile() &&
      /^source\.(mp4|mkv|webm|mov|m4v|flv|3gp|ts|avi)$/i.test(entry.name)
    );
    if (!sourceFile) {
      await cleanupTemp();
      return res.status(422).json({ error: 'The source did not return a playable video.' });
    }

    // Always normalize the actual codecs/container, not just the file extension.
    const conversion = await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', path.join(tempDir, sourceFile.name),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-sn', '-dn',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast',
      '-crf', process.env.FFMPEG_CRF || '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outputPath
    ], transcodeTimeout);

    if (res.destroyed) { await cleanupTemp(); return; }
    if (conversion.timedOut) {
      await cleanupTemp();
      return res.status(504).json({ error: 'Video conversion took too long. Please try again.' });
    }
    if (conversion.code !== 0) {
      console.error('[MR Downloader] FFmpeg conversion failed:', conversion.stderr.slice(-3000));
      await cleanupTemp();
      return res.status(422).json({ error: 'The downloaded video could not be converted to a compatible MP4.' });
    }

    const info = await stat(outputPath);
    if (!info.isFile() || info.size === 0) {
      await cleanupTemp();
      return res.status(422).json({ error: 'The source did not return a playable video.' });
    }

    res.status(200).set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="mr-downloader-video.mp4"',
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
    console.error('[MR Downloader] Request failed:', error.message);
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

app.listen(port, '0.0.0.0', () => console.log(\`MR Downloader listening on :\${port}\`));
