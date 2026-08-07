// immich-api.js
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();

const IMMICH_API = process.env.IMMICH_API;  // z.B. "http://192.168.3.108:2283/api"
const API_KEY = process.env.IMMICH_API_KEY;  // Dein API-Key
const DOWNLOAD_TIMEOUT_MS = Number(process.env.IMMICH_DOWNLOAD_TIMEOUT_MS) || 60000;
const DOWNLOAD_CONCURRENCY = Number(process.env.IMMICH_DOWNLOAD_CONCURRENCY) || 4;

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

      if (fs.existsSync(savePath)) {
          return savePath;
      }

      try {
          const response = await axios.get(`${IMMICH_API}/assets/${videoId}/original`, {
              headers: { 'x-api-key': API_KEY },
              responseType: 'stream',
              timeout: DOWNLOAD_TIMEOUT_MS,
          });

          const writer = fs.createWriteStream(savePath);
          response.data.pipe(writer);

          await new Promise((resolve, reject) => {
              writer.on('finish', resolve);
              writer.on('error', reject);
              response.data.on('error', reject);
          });

          console.log(`Live photo video saved: ${savePath}`);
          return savePath;
      } catch (error) {
          if (fs.existsSync(savePath)) {
              fs.unlinkSync(savePath);
          }
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
        if (fs.existsSync(filename)) {
            console.log(`Asset already exists: ${filename}`);
            return;
        }

        console.log("Saving asset to:", filename);
        try {
            const response = await axios.get(`${IMMICH_API}/assets/${asset.id}/original`, {
                headers: { 'x-api-key': API_KEY },
                responseType: 'stream',
                timeout: DOWNLOAD_TIMEOUT_MS,
            });
            const writer = fs.createWriteStream(filename);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.on('error', reject);
            });
        } catch (error) {
            if (fs.existsSync(filename)) {
                fs.unlinkSync(filename);
            }
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