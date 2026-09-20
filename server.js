const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Optional cookies.txt — if uploaded, used automatically
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const hasCookies = () => fs.existsSync(COOKIES_FILE);

function runYtDlp(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: timeoutMs
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function commonArgs() {
  const a = [
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificate',
    '--geo-bypass',
    '--user-agent', UA,
    '--retries', '3',
    '--socket-timeout', '30',
    '--no-cache-dir'
  ];
  if (hasCookies()) a.push('--cookies', COOKIES_FILE);
  return a;
}

// ============ YOUTUBE FALLBACK STRATEGIES ============
async function tryYtDlp(url, extraArgs = [], timeoutMs = 180000) {
  const isYT = /youtube|youtu\.be/i.test(url);

  // Try each strategy — some work when others don't
  const strategies = isYT ? [
    // Try latest trick first (mweb + android_vr combination)
    ['--extractor-args', 'youtube:player_client=android_vr,mweb;player_skip=webpage'],
    ['--extractor-args', 'youtube:player_client=ios,mweb'],
    ['--extractor-args', 'youtube:player_client=tv_embedded,web_embedded'],
    ['--extractor-args', 'youtube:player_client=android_vr'],
    ['--extractor-args', 'youtube:player_client=web_safari,tv'],
    ['--extractor-args', 'youtube:player_client=mweb'],
    ['--extractor-args', 'youtube:player_skip=webpage,configs;player_client=android_vr'],
    ['--extractor-args', 'youtube:player_client=android,ios'],
    [] // Default fallback
  ] : [[]];

  let lastErr = null;

  for (let i = 0; i < strategies.length; i++) {
    try {
      const args = [...extraArgs, ...commonArgs(), ...strategies[i], url];
      console.log(`[strategy ${i + 1}/${strategies.length}] Trying...`);
      const result = await runYtDlp(args, timeoutMs);
      console.log(`[strategy ${i + 1}] SUCCESS`);
      return result;
    } catch (e) {
      lastErr = e;
      const msg = (e.message || '').substring(0, 150);
      console.log(`[strategy ${i + 1}] FAILED: ${msg}`);
      // If not YouTube, no point retrying
      if (!isYT) break;
    }
  }

  throw lastErr || new Error('All strategies failed');
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Downloader API is running',
    cookies: hasCookies() ? 'loaded' : 'not loaded',
    version: '2.0'
  });
});

app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });

  try {
    const stdout = await tryYtDlp(url, ['-j'], 120000);
    const info = JSON.parse(stdout);

    const formats = (info.formats || []).map((f, i) => ({
      id: f.format_id || String(i),
      ext: f.ext,
      quality: f.format_note || f.resolution || (f.height ? f.height + 'p' : f.format_id),
      resolution: f.resolution,
      height: f.height,
      vCodec: f.vcodec,
      aCodec: f.acodec,
      filesize: f.filesize || f.filesize_approx,
      format_note: f.format_note
    }));

    res.json({
      ok: true,
      data: {
        title: info.title,
        thumbnailUrl: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader,
        formats
      }
    });
  } catch (e) {
    console.error('[info]', e.message);
    res.status(500).json({ ok: false, error: { message: e.message } });
  }
});

const tempFiles = new Map();

app.post('/api/download', async (req, res) => {
  const { url, format } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
    const outputTemplate = path.join(tmpDir, 'media.%(ext)s');

    const dlArgs = ['-o', outputTemplate];

    if (format && format !== 'auto' && format !== '') {
      // Smart format selection — try to merge with audio if possible
      dlArgs.push('-f', `${format}+bestaudio/${format}/best`);
    } else {
      // Best video + best audio, merged to mp4
      dlArgs.push('-f', 'bestvideo+bestaudio/best');
    }

    dlArgs.push('--merge-output-format', 'mp4');

    await tryYtDlp(url, dlArgs, 170000);

    // Look for the produced file
    const files = fs.readdirSync(tmpDir).filter(f => !f.endsWith('.part') && !f.startsWith('.'));
    if (!files.length) throw new Error('Download failed — no file produced');

    // Pick the biggest file (in case of multiple)
    let biggest = null;
    let biggestSize = 0;
    for (const f of files) {
      const fp = path.join(tmpDir, f);
      const st = fs.statSync(fp);
      if (st.size > biggestSize) {
        biggestSize = st.size;
        biggest = { path: fp, name: f };
      }
    }

    if (!biggest || biggestSize < 1000) throw new Error('File too small — download failed');

    const token = crypto.randomBytes(16).toString('hex');
    tempFiles.set(token, {
      path: biggest.path,
      name: biggest.name,
      expires: Date.now() + 15 * 60 * 1000  // 15 min to allow retry
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    console.log(`[download] ready: ${biggest.name} (${(biggestSize / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ ok: true, url: `${baseUrl}/api/file/${token}`, size: biggestSize });
  } catch (e) {
    console.error('[download]', e.message);
    res.status(500).json({ ok: false, error: { message: e.message } });
  }
});

// Serve the file — allow multiple downloads of same token
app.get('/api/file/:token', (req, res) => {
  const rec = tempFiles.get(req.params.token);
  if (!rec) return res.status(404).send('File not found or expired');
  if (Date.now() > rec.expires) {
    tempFiles.delete(req.params.token);
    try { fs.unlinkSync(rec.path); } catch (e) {}
    return res.status(410).send('File expired');
  }
  if (!fs.existsSync(rec.path)) {
    tempFiles.delete(req.params.token);
    return res.status(404).send('File already deleted');
  }

  // Force download with proper headers
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rec.name)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(rec.path);
  stream.pipe(res);
  stream.on('error', (err) => {
    console.error('Stream error:', err);
    if (!res.headersSent) res.status(500).end();
  });
  // DO NOT delete here — allow retries. Cleanup happens via interval
});

// Cleanup expired files every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of tempFiles.entries()) {
    if (now > rec.expires) {
      try { fs.unlinkSync(rec.path); } catch (e) {}
      tempFiles.delete(token);
      console.log('[cleanup] removed expired:', rec.name);
    }
  }
}, 5 * 60 * 1000);

// Also clean up old temp dirs on startup
try {
  const tmp = os.tmpdir();
  const old = fs.readdirSync(tmp).filter(f => f.startsWith('dl-'));
  for (const f of old) {
    try { fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); } catch (e) {}
  }
} catch (e) {}

app.listen(PORT, () => console.log('Server running on port', PORT));
