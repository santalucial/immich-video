const fs = require('fs');
const path = require('path');
const { fetchAlbum, downloadAsset } = require('./immich-api');
const FormData = require('form-data');
const axios = require('axios');
require('./ffmpeg-utils'); // configures fluent-ffmpeg path

//.env
const GOOGLE_TRANSLATE_KEY = process.env.GOOGLE_TRANSLATE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Pfade
const mediaFolder = path.join(__dirname, '../medien');
const tempFolder = path.join(__dirname, '../../temp');

module.exports = {
  generateVideo: async (options) => {
    try {
      // Album laden
      // ...
      const album = await fetchAlbum();
      console.log(`Album loaded: ${album.albumName}`);

      // Medien herunterladen
      await Promise.all(album.assets.map(async (asset) => {
        // Wir verwenden originalFileName
        // z.B. "20250312_170019.jpg"
        const fileName = path.join(mediaFolder, asset.originalFileName);
        console.log("Saving file:", fileName);
        await downloadAsset(asset, fileName);
        console.log("mediaFolder in main-process:", mediaFolder);
        // Wichtig: Im Asset merken wir uns den Dateinamen für das Frontend
        asset.downloadName = asset.originalFileName;
      }));

      // ...


      // Videoerstellung
      const outputFile = path.join(__dirname, '../../output.mp4');
      // ... restliche FFmpeg Logik hier ...

      return outputFile;
    } catch (error) {
      throw error;
    }
  }
};