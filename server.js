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
  res.json({
    ok: true,
    message: 'Downloader API is running',
    cookies: hasCookies() ? 'loaded' : 'not loaded',
    version: '2.1'
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
    // Use proper filename template so file names come from title
    const outputTemplate = path.join(tmpDir, '%(title).80s.%(ext)s');

    const dlArgs = ['-o', outputTemplate];

    // ========== FORMAT SELECTION LOGIC ==========
    // If auto → best video + best audio, merged to mp4
    // If specific format ID → try that format + best audio, fallback to best
    const f = (format || 'auto').trim().toLowerCase();

    if (f === 'auto' || f === '') {
      // Best video + best audio that has both, or best combined
      dlArgs.push('-f', 'bv*+ba/b');
      dlArgs.push('--merge-output-format', 'mp4');
    } else if (f === 'best') {
      dlArgs.push('-f', 'bv*+ba/b');
      dlArgs.push('--merge-output-format', 'mp4');
    } else {
      // Specific format ID from frontend.
      // Try: <id>+bestaudio  →  <id>  →  best
      dlArgs.push('-f', `${format}+ba/${format}/bv*+ba/b`);
      dlArgs.push('--merge-output-format', 'mp4');
    }

    // Always prefer mp4 container and prefer bigger resolution if merging
    dlArgs.push('--merge-output-format', 'mp4');

    await tryYtDlp(url, dlArgs, 170000);

    // Find produced file (ignore .part)
    const allFiles = fs.readdirSync(tmpDir).filter(f => !f.endsWith('.part') && !f.startsWith('.'));
    if (!allFiles.length) throw new Error('Download failed — no file produced');

    // Pick the biggest file (in case of multiple outputs)
    let biggest = null;
    let biggestSize = 0;
    for (const fn of allFiles) {
      const fp = path.join(tmpDir, fn);
      const st = fs.statSync(fp);
      if (st.size > biggestSize) {
        biggestSize = st.size;
        biggest = { path: fp, name: fn };
      }
    }

    if (!biggest || biggestSize < 1000) throw new Error('File too small — download failed');

    // Warn if we accidentally only got audio (video mode should not produce .mp3/.m4a)
    const ext = path.extname(biggest.name).toLowerCase();
    const isAudioExt = ['.mp3', '.m4a', '.opus', '.ogg', '.wav', '.aac'].includes(ext);

    if (isAudioExt && f !== 'auto' && f !== 'best') {
      // Attempted video but got audio — try one more time forcing video
      console.log('[retry] Got audio-only, forcing bestvideo...');
      // cleanup tmpDir
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      // Try again with strict video format
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dl2-'));
      const out2 = path.join(tmpDir2, '%(title).80s.%(ext)s');
      const args2 = ['-o', out2, '-f', 'bv*+ba/b', '--merge-output-format', 'mp4'];
      await tryYtDlp(url, args2, 170000);
      const files2 = fs.readdirSync(tmpDir2).filter(x => !x.endsWith('.part'));
      if (!files2.length) throw new Error('Video format not available for this URL');
      let b2 = null, s2 = 0;
      for (const fn of files2) {
        const st = fs.statSync(path.join(tmpDir2, fn));
        if (st.size > s2) { s2 = st.size; b2 = { path: path.join(tmpDir2, fn), name: fn }; }
      }
      biggest = b2;
      biggestSize = s2;
      // update tmpDir path for cleanup
    }

    const token = crypto.randomBytes(16).toString('hex');
    tempFiles.set(token, {
      path: biggest.path,
      name: biggest.name,
      expires: Date.now() + 15 * 60 * 1000
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    console.log(`[download] ready: ${biggest.name} (${(biggestSize / 1024 / 1024).toFixed(2)} MB)`);
    res.json({ ok: true, url: `${baseUrl}/api/file/${token}`, size: biggestSize, filename: biggest.name });
  } catch (e) {
    console.error('[download]', e.message);
    res.status(500).json({ ok: false, error: { message: e.message } });
  }
});

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

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(rec.name)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(rec.path);
  stream.pipe(res);
  stream.on('error', (err) => {
    console.error('Stream error:', err);
    if (!res.headersSent) res.status(500).end();
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
  const old = fs.readdirSync(tmp).filter(f => f.startsWith('dl-') || f.startsWith('dl2-'));
  for (const f of old) {
    try { fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); } catch (e) {}
  }
} catch (e) {}

app.listen(PORT, () => console.log('Server running on port', PORT));
