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

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Downloader API is running' });
});

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function runYtDlp(args, timeoutMs = 100000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Try multiple yt-dlp strategies until one works
async function tryYtDlp(url, extraArgs = [], timeoutMs = 100000) {
  // Strategy list — different YouTube clients handle bot-detection differently
  const strategies = [
    ['--extractor-args', 'youtube:player_client=android,web,ios'],
    ['--extractor-args', 'youtube:player_client=ios,web'],
    ['--extractor-args', 'youtube:player_client=tv_embedded,web'],
    ['--extractor-args', 'youtube:player_client=mweb,web'],
    []
  ];

  let lastErr = null;
  for (const extra of strategies) {
    try {
      const args = [
        ...extraArgs,
        '--no-warnings',
        '--no-playlist',
        '--no-check-certificate',
        '--user-agent', USER_AGENT,
        '--geo-bypass',
        ...extra,
        url
      ];
      const out = await runYtDlp(args, timeoutMs);
      return out;
    } catch (e) {
      lastErr = e;
      // If it's not a YouTube URL, no point retrying other clients
      if (!/youtube|youtu\.be/i.test(url)) break;
    }
  }
  throw lastErr || new Error('All strategies failed');
}

app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });

  try {
    const stdout = await tryYtDlp(url, ['-j'], 100000);
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
    console.error('[info] error:', e.message);
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

    const baseArgs = ['-o', outputTemplate];
    if (format && format !== 'auto' && format !== '') {
      baseArgs.push('-f', format);
    } else {
      baseArgs.push('-f', 'best');
    }

    await tryYtDlp(url, baseArgs, 170000);

    const files = fs.readdirSync(tmpDir);
    if (!files.length) throw new Error('Download failed — no file');

    const filePath = path.join(tmpDir, files[0]);
    const token = crypto.randomBytes(16).toString('hex');
    tempFiles.set(token, {
      path: filePath,
      name: files[0],
      expires: Date.now() + 5 * 60 * 1000
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, url: `${baseUrl}/api/file/${token}` });
  } catch (e) {
    console.error('[download] error:', e.message);
    res.status(500).json({ ok: false, error: { message: e.message } });
  }
});

app.get('/api/file/:token', (req, res) => {
  const rec = tempFiles.get(req.params.token);
  if (!rec) return res.status(404).send('File not found');
  if (Date.now() > rec.expires) {
    tempFiles.delete(req.params.token);
    try { fs.unlinkSync(rec.path); } catch(e){}
    return res.status(410).send('File expired');
  }
  res.download(rec.path, rec.name, () => {
    tempFiles.delete(req.params.token);
    try { fs.unlinkSync(rec.path); } catch(e){}
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, rec] of tempFiles.entries()) {
    if (now > rec.expires) {
      try { fs.unlinkSync(rec.path); } catch(e){}
      tempFiles.delete(token);
    }
  }
}, 60 * 1000);

app.listen(PORT, () => console.log('Server running on port', PORT));
