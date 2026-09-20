const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Full CORS
app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '5mb' }));

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

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
  const a = ['--no-warnings','--no-playlist','--no-check-certificate','--geo-bypass',
    '--user-agent', UA,'--retries','3','--socket-timeout','30','--no-cache-dir'];
  if (hasCookies()) a.push('--cookies', COOKIES_FILE);
  return a;
}

async function tryYtDlp(url, extraArgs = [], timeoutMs = 180000) {
  const isYT = /youtube|youtu\.be/i.test(url);
  const strategies = isYT ? [
    ['--extractor-args', 'youtube:player_client=android_vr,mweb;player_skip=webpage'],
    ['--extractor-args', 'youtube:player_client=ios,mweb'],
    ['--extractor-args', 'youtube:player_client=tv_embedded,web_embedded'],
    ['--extractor-args', 'youtube:player_client=android_vr'],
    ['--extractor-args', 'youtube:player_client=web_safari,tv'],
    ['--extractor-args', 'youtube:player_client=mweb'],
    ['--extractor-args', 'youtube:player_skip=webpage,configs;player_client=android_vr'],
    ['--extractor-args', 'youtube:player_client=android,ios'],
    []
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
      console.log(`[strategy ${i + 1}] FAILED: ${(e.message || '').substring(0, 140)}`);
      if (!isYT) break;
    }
  }
  throw lastErr || new Error('All strategies failed');
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Downloader API is running', cookies: hasCookies() ? 'loaded' : 'not loaded', version: '3.0' });
});

app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  try {
    const stdout = await tryYtDlp(url, ['-j'], 120000);
    const info = JSON.parse(stdout);
    const formats = (info.formats || []).map((f, i) => ({
      id: f.format_id || String(i), ext: f.ext,
      quality: f.format_note || f.resolution || (f.height ? f.height + 'p' : f.format_id),
      resolution: f.resolution, height: f.height,
      vCodec: f.vcodec, aCodec: f.acodec,
      filesize: f.filesize || f.filesize_approx, format_note: f.format_note
    }));
    res.json({ ok: true, data: {
      title: info.title, thumbnailUrl: info.thumbnail,
      duration: info.duration, uploader: info.uploader, formats
    }});
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
    const outputTemplate = path.join(tmpDir, '%(title).80s.%(ext)s');
    const dlArgs = ['-o', outputTemplate];
    const f = (format || 'auto').trim().toLowerCase();

    if (f === 'auto' || f === 'best' || f === '') {
      dlArgs.push('-f', 'bv*+ba/b');
    } else {
      dlArgs.push('-f', `${format}+ba/${format}/bv*+ba/b`);
    }
    dlArgs.push('--merge-output-format', 'mp4');

    await tryYtDlp(url, dlArgs, 170000);

    const allFiles = fs.readdirSync(tmpDir).filter(fn => !fn.endsWith('.part') && !fn.startsWith('.'));
    if (!allFiles.length) throw new Error('No file produced');

    let biggest = null, biggestSize = 0;
    for (const fn of allFiles) {
      const fp = path.join(tmpDir, fn);
      const st = fs.statSync(fp);
      if (st.size > biggestSize) { biggestSize = st.size; biggest = { path: fp, name: fn }; }
    }
    if (!biggest || biggestSize < 1000) throw new Error('File too small');

    const token = crypto.randomBytes(16).toString('hex');
    tempFiles.set(token, { path: biggest.path, name: biggest.name, expires: Date.now() + 20 * 60 * 1000 });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    console.log(`[download] ready: ${biggest.name} (${(biggestSize / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ ok: true, url: `${baseUrl}/api/file/${token}`, size: biggestSize, filename: biggest.name });
  } catch (e) {
    console.error('[download]', e.message);
    res.status(500).json({ ok: false, error: { message: e.message } });
  }
});

// ============ FILE DOWNLOAD (SIMPLE + RELIABLE) ============
app.get('/api/file/:token', (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');

  const rec = tempFiles.get(req.params.token);
  if (!rec) return res.status(404).send('File not found');
  if (Date.now() > rec.expires) {
    tempFiles.delete(req.params.token);
    try { fs.unlinkSync(rec.path); } catch (e) {}
    return res.status(410).send('File expired');
  }
  if (!fs.existsSync(rec.path)) return res.status(404).send('File gone');

  // Use express res.download — sets Content-Disposition properly
  // DON'T delete file — allows retry. Cleanup via interval.
  res.download(rec.path, rec.name, (err) => {
    if (err) console.error('Download err:', err.message);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of tempFiles.entries()) {
    if (now > rec.expires) {
      try { fs.unlinkSync(rec.path); } catch (e) {}
      tempFiles.delete(token);
    }
  }
}, 5 * 60 * 1000);

try {
  const tmp = os.tmpdir();
  const old = fs.readdirSync(tmp).filter(f => f.startsWith('dl-'));
  for (const f of old) {
    try { fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); } catch (e) {}
  }
} catch (e) {}

app.listen(PORT, () => console.log('Server running on port', PORT));
