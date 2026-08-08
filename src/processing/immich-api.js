// immich-api.js
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();

const IMMICH_API = process.env.IMMICH_API;  // z.B. "http://192.168.3.108:2283/api"
const API_KEY = process.env.IMMICH_API_KEY;  // Dein API-Key
// Large originals over a remote Immich host often exceed 60s; truncated files then look "present".
const DOWNLOAD_TIMEOUT_MS = Number(process.env.IMMICH_DOWNLOAD_TIMEOUT_MS) || 10 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = Number(process.env.IMMICH_DOWNLOAD_CONCURRENCY) || 4;
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.3gp']);

console.log("IMMICH_API:", IMMICH_API);
console.log("IMMICH_API_KEY configured:", Boolean(API_KEY));

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function run() {
        while (nextIndex < items.length) {
            const current = nextIndex++;
            results[current] = await worker(items[current], current);
        }
    }

    const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
    await Promise.all(runners);
    return results;
}

function isVideoPath(filePath) {
    return VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * Walk ISO BMFF / QuickTime atoms. Truncated downloads usually claim an mdat size
 * larger than the file and never reach a moov atom — FFmpeg then fails with
 * "moov atom not found" / "Invalid data found when processing input".
 */
function isValidMp4LikeContainer(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const fileSize = fs.fstatSync(fd).size;
        if (fileSize < 16) return false;

        const header = Buffer.alloc(16);
        let offset = 0;
        let sawMoov = false;

        while (offset + 8 <= fileSize) {
            fs.readSync(fd, header, 0, 8, offset);
            let atomSize = header.readUInt32BE(0);
            const type = header.toString('ascii', 4, 8);
            let headerLen = 8;

            if (atomSize === 1) {
                if (offset + 16 > fileSize) return false;
                fs.readSync(fd, header, 8, 8, offset + 8);
                atomSize = Number(header.readBigUInt64BE(8));
                headerLen = 16;
            } else if (atomSize === 0) {
                atomSize = fileSize - offset;
            }

            if (!Number.isFinite(atomSize) || atomSize < headerLen) return false;
            if (offset + atomSize > fileSize) return false;

            if (type === 'moov') sawMoov = true;
            offset += atomSize;
        }

        return sawMoov && offset === fileSize;
    } catch {
        return false;
    } finally {
        if (fd != null) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/** True when path exists, has content, and (for video) is a complete container. */
function isUsableLocalFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const size = fs.statSync(filePath).size;
        if (size <= 0) return false;
        if (isVideoPath(filePath) && !isValidMp4LikeContainer(filePath)) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function removeIfExists(filePath) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.warn(`Could not remove ${filePath}:`, err.message);
    }
}

/**
 * Stream Immich original to disk atomically (temp + rename).
 * Rejects empty/truncated responses so corrupt stubs never skip future downloads.
 */
async function streamDownloadToFile(url, savePath) {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${savePath}.part`;
    removeIfExists(tempPath);

    try {
        const response = await axios.get(url, {
            headers: { 'x-api-key': API_KEY },
            responseType: 'stream',
            timeout: DOWNLOAD_TIMEOUT_MS,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        const expectedLength = Number(response.headers['content-length']);
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            const fail = (err) => {
                response.data.destroy();
                writer.destroy();
                reject(err);
            };
            writer.on('finish', resolve);
            writer.on('error', fail);
            response.data.on('error', fail);
        });

        const size = fs.statSync(tempPath).size;
        if (size <= 0) {
            throw new Error(`Downloaded empty file from ${url}`);
        }
        if (Number.isFinite(expectedLength) && expectedLength > 0 && size !== expectedLength) {
            throw new Error(
                `Truncated download for ${path.basename(savePath)}: got ${size} bytes, expected ${expectedLength}`
            );
        }
        if (isVideoPath(savePath) && !isValidMp4LikeContainer(tempPath)) {
            throw new Error(
                `Downloaded incomplete/corrupt video ${path.basename(savePath)} (missing moov / truncated mdat)`
            );
        }

        removeIfExists(savePath);
        fs.renameSync(tempPath, savePath);
        return savePath;
    } catch (error) {
        removeIfExists(tempPath);
        throw error;
    }
}

async function fetchAlbumAssets(albumId) {
    const assets = [];
    let page = 1;

    // Immich v3+: AlbumResponseDto no longer includes assets.
    // Fetch via search/metadata with albumIds filter (paginated, max size 1000).
    while (true) {
        const response = await axios.post(
            `${IMMICH_API}/search/metadata`,
            { albumIds: [albumId], page, size: 1000 },
            {
                headers: {
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            }
        );

        const pageAssets = response.data?.assets?.items || [];
        assets.push(...pageAssets);

        const nextPage = response.data?.assets?.nextPage;
        if (!nextPage || pageAssets.length === 0) {
            break;
        }
        page = Number(nextPage) || page + 1;
    }

    console.log(`Fetched album assets: ${assets.length} for album ${albumId}`);
    return assets;
}

module.exports = {
    isUsableLocalFile,

    // Abrufen eines Albums anhand der übergebenen Album-ID
    fetchAlbum: async (albumId) => {
        if (!albumId) {
            throw new Error("Album ID is missing");
        }
        try {
            const response = await axios.get(`${IMMICH_API}/albums/${albumId}`, {
                headers: { 'x-api-key': API_KEY }
            });
            const album = response.data;
            // Immich v3 removed assets from GET /albums/:id — attach them for callers.
            if (!Array.isArray(album.assets)) {
                album.assets = await fetchAlbumAssets(albumId);
            }
            console.log("Album fetched successfully:", {
                albumName: album.albumName,
                id: album.id,
                assetCount: album.assets.length,
            });
            return album;
        } catch (error) {
            console.error("Error fetching album:", error.message);
            if (error.response) {
                console.error("Status:", error.response.status);
                console.error("Data:", error.response.data);
            }
            throw error;
        }
    },

    


    downloadLivePhotoVideo: async (videoId, savePath) => {
      console.log(`Downloading live video: ${videoId}`);

      if (isUsableLocalFile(savePath)) {
          return savePath;
      }
      if (fs.existsSync(savePath)) {
          console.warn(`Removing empty/corrupt stub: ${savePath}`);
          removeIfExists(savePath);
      }

      try {
          await streamDownloadToFile(`${IMMICH_API}/assets/${videoId}/original`, savePath);
          console.log(`Live photo video saved: ${savePath}`);
          return savePath;
      } catch (error) {
          removeIfExists(savePath);
          console.error(`Error downloading live photo video ${videoId}:`, error.message);
          if (error.response) {
              console.error("Status:", error.response.status);
              console.error("Data:", error.response.data);
          }
          throw error;
      }
  },

    // Funktion, um alle Alben abzurufen (wenn die API dies unterstützt)
    fetchAlbums: async () => {
        try {
            const response = await axios.get(`${IMMICH_API}/albums`, {
                headers: { 'x-api-key': API_KEY }
            });
            console.log("Albums fetched successfully:", response.data);
            return response.data;
        } catch (error) {
            console.error("Error fetching albums:", error.message);
            if (error.response) {
                console.error("Status:", error.response.status);
                console.error("Data:", error.response.data);
            }
            throw error;
        }
    },

    downloadAsset: async (asset, filename) => {
        if (isUsableLocalFile(filename)) {
            console.log(`Asset already exists: ${filename}`);
            return;
        }
        if (fs.existsSync(filename)) {
            console.warn(`Removing empty/corrupt stub: ${filename}`);
            removeIfExists(filename);
        }

        console.log("Saving asset to:", filename);
        try {
            await streamDownloadToFile(`${IMMICH_API}/assets/${asset.id}/original`, filename);
        } catch (error) {
            removeIfExists(filename);
            console.error("Error downloading asset:", error.message);
            throw error;
        }
    },

    /**
     * Download many assets with limited concurrency. Continues on individual failures.
     * jobs: [{ asset: { id }, filename }] or [{ videoId, filename }] for live videos
     */
    downloadAssetsLimited: async (jobs, concurrency = DOWNLOAD_CONCURRENCY) => {
        let done = 0;
        let failed = 0;
        await mapWithConcurrency(jobs, concurrency, async (job) => {
            try {
                if (job.videoId) {
                    const { downloadLivePhotoVideo } = module.exports;
                    await downloadLivePhotoVideo(job.videoId, job.filename);
                } else {
                    await module.exports.downloadAsset(job.asset, job.filename);
                }
            } catch (error) {
                failed += 1;
                console.warn(`Download skipped (${job.filename}): ${error.message}`);
            } finally {
                done += 1;
                if (done % 25 === 0 || done === jobs.length) {
                    console.log(`Download progress: ${done}/${jobs.length} (failed: ${failed})`);
                }
            }
        });
        return { done, failed };
    },

    streamAssetThumbnail: async (assetId, res) => {
        const response = await axios.get(`${IMMICH_API}/assets/${assetId}/thumbnail`, {
            headers: { 'x-api-key': API_KEY },
            responseType: 'stream',
            timeout: DOWNLOAD_TIMEOUT_MS,
            params: { size: 'thumbnail' },
        });
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        res.setHeader('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    },

    /**
     * Stream Immich video for HTML5 <video> (supports Range / seeking).
     * Does not write files to disk.
     */
    streamAssetVideo: async (assetId, req, res) => {
        const headers = { 'x-api-key': API_KEY };
        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await axios.get(`${IMMICH_API}/assets/${assetId}/video/playback`, {
            headers,
            responseType: 'stream',
            timeout: 0,
            validateStatus: (status) => status === 200 || status === 206,
        });

        res.status(response.status);
        const forwardHeaders = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'cache-control',
        ];
        for (const name of forwardHeaders) {
            if (response.headers[name]) {
                res.setHeader(name, response.headers[name]);
            }
        }
        if (!response.headers['accept-ranges']) {
            res.setHeader('Accept-Ranges', 'bytes');
        }
        if (!response.headers['content-type']) {
            res.setHeader('Content-Type', 'video/mp4');
        }

        req.on('close', () => {
            response.data.destroy();
        });
        response.data.pipe(res);
    },

    // Upload-Funktion, angepasst an die API-Dokumentation:
    uploadAssetFile: async (filePath) => {
        const form = new FormData();
        // Datei anhängen – als assetData
        form.append('assetData', fs.createReadStream(filePath));
        // Zusätzliche Felder – hier kannst du Testwerte verwenden oder später dynamisch füllen:
        form.append('deviceAssetId', '12345678-90ab-cdef-1234-567890abcdef');
        form.append('deviceId', 'device-1234');
        form.append('fileCreatedAt', new Date().toISOString());
        form.append('fileModifiedAt', new Date().toISOString());

        console.log("Uploading file:", filePath);
        try {
            console.log("FormData object:", form); // Logge das FormData-Objekt

            const response = await axios.post(`${IMMICH_API}/assets`, form, {
                headers: {
                    ...form.getHeaders(),
                    'x-api-key': API_KEY,
                    // Falls benötigt, kannst du hier auch einen Dummy-Checksum-Header hinzufügen:
                    // 'x-immich-checksum': 'dummychecksum'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            console.log("Upload response:", response.data);
            return response.data;
        } catch (error) {
            console.error("Error uploading asset:", error.message);
            if (error.response) {
                console.error("Status:", error.response.status);
                console.error("Data:", error.response.data);
                console.error("Headers:", error.response.headers); // Logge die Response-Header
            }
            throw error;
        }
    },

    addAssetsToAlbum: async (albumId, assetIds) => {
        if (!albumId || !assetIds || !Array.isArray(assetIds)) {
            throw new Error("Invalid parameters: album ID and an array of asset IDs are required.");
        }
        const data = { ids: assetIds };
        try {
            const response = await axios.put(`${IMMICH_API}/albums/${albumId}/assets`, data, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'x-api-key': API_KEY
                }
            });
            console.log("Assets added to album successfully:", response.data);
            return response.data;
        } catch (error) {
            console.error("Error adding assets to album:", error.message);
            if (error.response) {
                console.error("Status:", error.response.status);
                console.error("Data:", error.response.data);
            }
            throw error;
        }
    }
};