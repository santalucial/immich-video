const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const dotenv = require('dotenv');
const FormData = require('form-data');
const multer = require('multer');
const { execSync } = require('child_process');
const { generateVideo } = require('./processing/main-process');
const { generateTitleOnly } = require('./processing/titel-generator');
const { createIntroClip } = require('./processing/intro');
const { generateFinalVideo } = require('./processing/final-video');
const { uploadAssetFile, addAssetsToAlbum } = require('./processing/immich-api');
const { downloadLivePhotoVideo } = require('./processing/immich-api');
const { generateThumbnail } = require('./processing/video-thumbnail');
const { generateMusicTagsOnly } = require('./processing/titel-generator');


require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;


// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const uploadsAudioDir = path.join(__dirname, '../uploads/audio');
if (!fs.existsSync(uploadsAudioDir)) {
  fs.mkdirSync(uploadsAudioDir, { recursive: true });
  console.log('"uploads/audio/" created.');
}
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.aac']);
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsAudioDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.mp3';
      const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 64) || 'audio';
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (AUDIO_EXTS.has(ext)) cb(null, true);
    else cb(new Error('Unsupported audio format. Use mp3, wav, m4a, ogg, or aac.'));
  }
});

function probeAudioDurationSec(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const sec = parseFloat(output.toString().trim());
    return Number.isFinite(sec) ? sec : 10;
  } catch (err) {
    console.warn('ffprobe duration failed:', err.message);
    return 10;
  }
}

app.post('/api/upload-audio', (req, res) => {
  audioUpload.single('file')(req, res, (err) => {
    if (err) {
      console.error('POST /api/upload-audio - upload error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }
      const duration = probeAudioDurationSec(req.file.path);
      const url = `/uploads/audio/${req.file.filename}`;
      console.log(`POST /api/upload-audio - saved ${req.file.filename} (${duration.toFixed(2)}s)`);
      res.json({
        id: req.file.filename,
        url,
        filename: req.file.originalname,
        duration
      });
    } catch (error) {
      console.error('POST /api/upload-audio - error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Ordnerstruktur
const mediaFolder = path.join('medien');
if (!fs.existsSync(mediaFolder)) {
  fs.mkdirSync(mediaFolder, { recursive: true });
  console.log('"medien/" created.');
}

const tempFolder = path.join(__dirname, '../temp');
if (!fs.existsSync(tempFolder)) {
  fs.mkdirSync(tempFolder, { recursive: true });
  console.log(`Temp folder created: ${tempFolder}`);
}

const processingMediaFolder = path.join(__dirname, 'processing', 'medien');
if (!fs.existsSync(processingMediaFolder)) {
  fs.mkdirSync(processingMediaFolder, { recursive: true });
  console.log('"processing/medien/" created.');
}

// Statische Pfade
const mediaPath = path.join(__dirname, '../medien');
app.use('/media', express.static(mediaPath));
console.log("Media path:", mediaPath);

const outputPath = path.join(__dirname, '../public/output');
if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });
app.use('/output', express.static(outputPath));
console.log("Output path:", outputPath);

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// API-Endpunkte
app.get('/api/albums', async (req, res) => {
  try {
    const { fetchAlbums } = require('./processing/immich-api');
    const albums = await fetchAlbums();
    console.log("GET /api/albums - response:", albums);
    res.json(albums);
  } catch (error) {
    console.error("GET /api/albums - error:", error);
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/videoThumbnail', async (req, res) => {
  const { videoName } = req.query;

  if (!videoName) {
    return res.status(400).json({ error: 'videoName is required' });
  }

  try {
    const videoPath = path.join(__dirname, '../medien', videoName);
    const thumbnailPath = path.join(__dirname, '../medien/thumbnails');

    // Sicherstellen, dass das Thumbnail-Verzeichnis existiert
    fs.mkdirSync(thumbnailPath, { recursive: true });

    const thumbPath = await generateThumbnail(videoPath, thumbnailPath);

    if (!fs.existsSync(thumbPath)) {
      return res.status(404).json({ error: 'Could not create thumbnail' });
    }

    res.sendFile(thumbPath);
  } catch (error) {
    console.error("Error fetching thumbnail:", error.message);
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/generateTitle', async (req, res) => {
  try {
    const ALBUM_ID = req.query.albumId;
    const generatedTitles = await generateTitleOnly(ALBUM_ID);
    console.log("GET /api/generateTitle - response:", generatedTitles);
    res.json({ finalTitles: generatedTitles });
  } catch (error) {
    console.error("GET /api/generateTitle - error:", error);
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/album', async (req, res) => {
  try {
    const albumId = req.query.albumId;
    if (!albumId) {
      console.error("GET /api/album - error: album ID missing");
      return res.status(400).send("Album ID is required");
    }
    const { fetchAlbum } = require('./processing/immich-api');
    const album = await fetchAlbum(albumId);
    console.log(`GET /api/album - album loaded: ${album.albumName} (${album.assets.length} Assets)`);

    const responseAssets = [];

    for (const asset of album.assets) {
      asset.downloadName = asset.originalFileName;
      responseAssets.push(asset);

      if (asset.livePhotoVideoId) {
        const liveVideoFileName = `${asset.livePhotoVideoId}.mp4`;
        responseAssets.push({
          id: asset.livePhotoVideoId,
          type: 'VIDEO',
          downloadName: liveVideoFileName,
          originalFileName: liveVideoFileName,
          duration: 3000,
          isLivePhoto: true,
          sourceImageId: asset.id,
          livePhotoVideoId: asset.livePhotoVideoId,
        });
      }
    }

    // Metadata only — originals are downloaded on demand (export / ensureDownloads).
    console.log(`GET /api/album - responding with ${responseAssets.length} assets (no downloads)`);
    res.json(responseAssets);
  } catch (error) {
    console.error("GET /api/album - error:", error);
    res.status(500).send(error.message);
  }
});

app.get('/api/immich/thumbnail/:id', async (req, res) => {
  try {
    const { streamAssetThumbnail } = require('./processing/immich-api');
    await streamAssetThumbnail(req.params.id, res);
  } catch (error) {
    console.error('Thumbnail proxy error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Could not load thumbnail' });
    }
  }
});

app.get('/api/immich/video/:id', async (req, res) => {
  try {
    const { streamAssetVideo } = require('./processing/immich-api');
    await streamAssetVideo(req.params.id, req, res);
  } catch (error) {
    console.error('Video proxy error:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Could not stream video' });
    }
  }
});

app.post('/api/ensureDownloads', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.json({ success: true, downloaded: 0 });
    }

    const { downloadAssetsLimited } = require('./processing/immich-api');
    const mediaFolder = path.join(__dirname, '../medien');
    if (!fs.existsSync(mediaFolder)) {
      fs.mkdirSync(mediaFolder, { recursive: true });
    }

    const jobs = items
      .filter((item) => item?.downloadName)
      .map((item) => {
        const filename = path.join(mediaFolder, item.downloadName);
        if (item.isLivePhoto || item.livePhotoVideoId) {
          return { videoId: item.livePhotoVideoId || item.id, filename };
        }
        if (!item.id) return null;
        return { asset: { id: item.id }, filename };
      })
      .filter(Boolean);

    const result = await downloadAssetsLimited(jobs);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('POST /api/ensureDownloads - error:', error);
    res.status(500).json({ error: error.message });
  }
});

const envPath = path.join(__dirname, '../.env');

// GET: .env laden und als JSON senden
app.get('/api/env', (req, res) => {
  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  res.json(envConfig);
});

// POST: .env speichern (überschreibt die Datei)
app.post('/api/env', (req, res) => {
  const newEnv = req.body;
  const envString = Object.entries(newEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  fs.writeFileSync(envPath, envString);
  res.json({ success: true });
});


app.post('/api/intro', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) {
      console.error("POST /api/intro - error: no title provided");
      return res.status(400).json({ error: 'No title provided' });
    }

    const outputFile = path.join(__dirname, '../medien', 'intro.mp4');
    await createIntroClip(title, outputFile);
    console.log("POST /api/intro - intro clip created:", outputFile);
    res.json({ success: true, file: outputFile });
  } catch (error) {
    console.error("POST /api/intro - error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/export', async (req, res) => {
  console.log("POST /api/export - Request Body:", req.body);
  try {
    const exportData = {
      title: req.body.title,
      media: req.body.media,
      resolution: req.body.resolution,
      audio: req.body.audio
    };
    if (exportData.audio && Array.isArray(exportData.audio)) {
      console.log(`🎧 Audio received – count: ${exportData.audio.length}`);
    } else {
      console.log('🚫 No audio included in export request.');
    }

    let outputFileName = exportData.title ? exportData.title : 'final-video';
    outputFileName = outputFileName.replace(/[^a-zA-Z0-9]+/g, '_');
    outputFileName = `${outputFileName}.mp4`;
    const outputDir = path.join(__dirname, '../public/output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, outputFileName);
    const jobId = `export_${Date.now()}`;

    // Return immediately — download + encode in background; completion via SSE
    res.json({ success: true, started: true, jobId, file: outputPath });

    setImmediate(async () => {
      try {
        sendProgressUpdate(`🚀 Background export started (${jobId})…`);
        sendProgressUpdate(`⬇️ Ensuring media downloads…`);
        const { downloadAssetsLimited } = require('./processing/immich-api');
        const downloadFolder = path.join(__dirname, '../medien');
        if (!fs.existsSync(downloadFolder)) fs.mkdirSync(downloadFolder, { recursive: true });
        const jobs = (exportData.media || [])
          .filter((item) => item?.downloadName && item.type !== 'TRANSITION')
          .map((item) => {
            const filename = path.join(downloadFolder, item.downloadName);
            if (item.isLivePhoto || item.livePhotoVideoId) {
              return { videoId: item.livePhotoVideoId || item.id, filename };
            }
            if (!item.id) return null;
            return { asset: { id: item.id }, filename };
          })
          .filter(Boolean);
        if (jobs.length) {
          const result = await downloadAssetsLimited(jobs);
          sendProgressUpdate(`⬇️ Downloads done (${result.done}, failed ${result.failed})`);
          if (result.failed > 0) {
            sendProgressUpdate(`⚠️ ${result.failed} download(s) failed — export may abort if those clips are required.`);
          }
        }
        const outputFile = await generateFinalVideo(exportData, outputPath, sendProgressUpdate);
        console.log("POST /api/export - final video created:", outputFile);
      } catch (error) {
        console.error("POST /api/export - background error:", error);
        sendProgressUpdate(`❌ Export failed: ${error.message}`);
      }
    });
  } catch (error) {
    console.error("POST /api/export - error:", error);
    res.status(500).send(error.message);
  }
});


app.get('/api/generateMusicTags', async (req, res) => {
  const { albumId } = req.query;
  try {
    const tags = await generateMusicTagsOnly(albumId);
    res.json(tags);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error generating music tags' });
  }
});



app.get('/api/livePhotoVideo', async (req, res) => {
  const { videoId } = req.query;

  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  const liveVideoPath = path.join(__dirname, 'media/live', `${videoId}.mp4`);

  // Prüfe, ob das Video bereits existiert
  if (!fs.existsSync(liveVideoPath)) {
    console.log(`Live-Video ${videoId} not found, downloading...`);
    try {
      await downloadLivePhotoVideo(videoId, liveVideoPath);
    } catch (error) {
      return res.status(500).json({ error: 'Error loading live photo video' });
    }
  }

  // Sende das gespeicherte Live-Video an den Client
  res.sendFile(liveVideoPath);
});

// Neuer API-Endpunkt zum Upload des finalen Videos und Hinzufügen zu einem Album
// server.js
app.post('/api/uploadFinal', async (req, res) => {
  try {
    const { albumId, title } = req.body; // Wir erwarten nun 'title'
    if (!albumId) {
      console.error("POST /api/uploadFinal - error: album ID missing in request body");
      return res.status(400).json({ error: 'Album ID is missing' });
    }
    console.log(`POST /api/uploadFinal - starting final video upload for album ${albumId}`);

    // Generiere den Dateinamen wie im Export-Endpoint
    let fileName = title && title.trim() ? title : 'final-video';
    fileName = fileName.replace(/[^a-zA-Z0-9]+/g, '_') + '.mp4';
    const finalVideoPath = path.join(__dirname, '../public/output', fileName);

    if (!fs.existsSync(finalVideoPath)) {
      console.error("POST /api/uploadFinal - error: final video not found at:", finalVideoPath);
      return res.status(400).json({ error: 'Final video not found' });
    }

    // 1. Upload des finalen Videos an Immich
    const form = new FormData();
    // Verwende 'assetData' anstelle von 'file'
    form.append('assetData', fs.createReadStream(finalVideoPath));
    // Füge die anderen erforderlichen Felder hinzu (wie im Doku-Beispiel)
    form.append('deviceAssetId', 'test-device-asset-id'); // Ersetze durch einen sinnvollen Wert
    form.append('deviceId', 'test-device-id'); // Ersetze durch einen sinnvollen Wert
    form.append('fileCreatedAt', new Date().toISOString());
    form.append('fileModifiedAt', new Date().toISOString());

    console.log("POST /api/uploadFinal - sending upload request to Immich for:", finalVideoPath);

    try {
      // ACHTUNG: Verwende hier /assets statt /assets/upload
      const uploadResponse = await axios.post(`${process.env.IMMICH_API}/assets`, form, {
        headers: {
          ...form.getHeaders(),
          'x-api-key': process.env.IMMICH_API_KEY,
          'Content-Type': 'multipart/form-data', // explizit setzen
          'Accept': 'application/json'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      console.log("POST /api/uploadFinal - Immich upload response:", uploadResponse.data);

      const assetId = uploadResponse.data.id;
      if (!assetId) {
        throw new Error('No asset ID received from upload');
      }
      console.log("POST /api/uploadFinal - received asset ID:", assetId);

      // 2. Füge das hochgeladene Asset dem Album hinzu
      const putData = { ids: [assetId] };
      console.log("POST /api/uploadFinal - sending PUT request to add asset to album:", albumId);

      try {
        const putResponse = await axios.put(
          `${process.env.IMMICH_API}/albums/${albumId}/assets`,
          putData,
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.IMMICH_API_KEY
            }
          }
        );
        console.log("POST /api/uploadFinal - add-to-album response:", putResponse.data);
        res.json({ success: true, result: putResponse.data });

      } catch (putError) {
        console.error("POST /api/uploadFinal - error adding to album:", putError.message);
        if (putError.response) {
          console.error("POST /api/uploadFinal - status:", putError.response.status);
          console.error("POST /api/uploadFinal - data:", putError.response.data);
        }
        return res.status(500).json({ error: putError.message });
      }

    } catch (uploadError) {
      console.error("POST /api/uploadFinal - upload error:", uploadError.message);
      if (uploadError.response) {
        console.error("POST /api/uploadFinal - status:", uploadError.response.status);
        console.error("POST /api/uploadFinal - data:", uploadError.response.data);
        console.error("POST /api/uploadFinal - headers:", uploadError.response.headers); // Logge die Request-Headers
      }
      return res.status(500).json({ error: uploadError.message });
    }

  } catch (error) {
    console.error('POST /api/uploadFinal - unexpected error:', error);
    res.status(500).json({ error: error.message });
  }
});

const { createProxyMiddleware } = require('http-proxy-middleware');

app.use('/proxy/ollama', createProxyMiddleware({
  target: 'http://localhost:11434',
  changeOrigin: true,
  pathRewrite: {
    '^/proxy/ollama': '/api', // 👈 ersetzt "proxy/ollama" durch "api"
  },
}));




const clients = []; // global am Anfang der Datei (z. B. direkt to `const app = express()` definieren)

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write('retry: 10000\n\n'); // Wiederverbindungsintervall für SSE

  clients.push(res);
  console.log("📡 New SSE client connected. Total:", clients.length);

  req.on('close', () => {
    const index = clients.indexOf(res);
    if (index !== -1) clients.splice(index, 1);
    console.log("❌ SSE client disconnected. Total:", clients.length);
  });
});


function sendProgressUpdate(message) {
  clients.forEach(client => {
    client.write(`data: ${message}\n\n`);
  });
}

module.exports = { sendProgressUpdate };


// Fortschritt-Sender global speichern
let currentExportClients = [];

app.get('/api/export-progress', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  // Direkt einmal "verbunden" senden
  res.write(`data: ⏳ Export started...\n\n`);

  currentExportClients.push(res);

  // Bei Disconnect entfernen
  req.on('close', () => {
    currentExportClients = currentExportClients.filter(c => c !== res);
  });
});





// Listen on :: (dual-stack when available) so both localhost (::1) and 127.0.0.1 work.
app.listen(port, '::', () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Also reachable at http://127.0.0.1:${port}`);
});