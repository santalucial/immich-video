const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { getImageCaptionLocal } = require('./image-caption');
const { fetchAlbum, downloadAsset } = require('./immich-api');

async function generateTitleOnly(albumId) {
  const album = await fetchAlbum(albumId);
  const albumName = album.albumName || "Album";

  const imageAssets = album.assets.filter(asset => asset.type === "IMAGE");
  if (imageAssets.length === 0) {
    return [albumName];
  }

  const mediaFolder = path.join(__dirname, 'medien');
  if (!fs.existsSync(mediaFolder)) {
    fs.mkdirSync(mediaFolder);
  }

  const downloadPromises = imageAssets.map((asset, idx) => {
    const ext = '.jpg';
    const fileName = path.join(mediaFolder, `temp_${String(idx + 1).padStart(3, '0')}${ext}`);
    return downloadAsset(asset, fileName).then(() => fileName);
  });
  const downloadedFiles = await Promise.all(downloadPromises);

  let captions = [];
  for (const file of downloadedFiles) {
    try {
      const caption = await getImageCaptionLocal(file);
      console.log(`Caption for ${file}:`, caption);
      captions.push(caption);
    } catch (error) {
      console.error(`Error creating caption for ${file}: ${error.message}`);
    }
  }

  const combinedCaption = captions.join(', ');

  const prompt = `
The existing album name is "${albumName}".
Please create creative, short English album titles
that use this name as inspiration and also consider the following image captions:

Image captions:
${combinedCaption}
  `;

  console.log('🧠 LLM prompt (local):', prompt);

  const ollamaEndpoint = process.env.OLLAMA_ENDPOINT;

  try {
    const response = await axios.post(
      ollamaEndpoint,
      {
        model: process.env.OLLAMA_MODEL,
        messages: [
          { role: 'system', content: 'You are a creative generator of English photo album titles.' },
          { role: 'user', content: prompt }
        ],
        stream: false
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.message.content.trim();
    console.log('✅ Generated title (Ollama):', content);
    return [content];
    
  } catch (error) {
    console.error('❌ Ollama request error:', error.message);
    return [albumName + ' – ' + combinedCaption];
  }
  
}

async function generateMusicTagsOnly(albumId) {
  const album = await fetchAlbum(albumId);
  const albumName = album.albumName || "Album";

  const imageAssets = album.assets.filter(asset => asset.type === "IMAGE");
  if (imageAssets.length === 0) return ['calm', 'emotional'];

  const mediaFolder = path.join(__dirname, 'medien');
  if (!fs.existsSync(mediaFolder)) fs.mkdirSync(mediaFolder);

  const downloadPromises = imageAssets.map((asset, idx) => {
    const fileName = path.join(mediaFolder, `musictemp_${String(idx + 1).padStart(3, '0')}.jpg`);
    return downloadAsset(asset, fileName).then(() => fileName);
  });

  const downloadedFiles = await Promise.all(downloadPromises);

  let captions = [];
  for (const file of downloadedFiles) {
    try {
      const caption = await getImageCaptionLocal(file);
      captions.push(caption);
    } catch (err) {
      console.error(`❌ Error describing image (${file}):`, err.message);
    }
  }

  const prompt = `
Please give me 3 to 6 English music search terms (genres or moods)
that fit the following visual impression based on these image captions:
No full sentences, only keywords. Write them comma-separated.

Image captions:
${captions.join(', ')}
`;

  console.log('🎼 Music tags prompt:', prompt);

  try {
    
    const response = await axios.post(process.env.OLLAMA_ENDPOINT, {
      model: process.env.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: 'You are an expert in music genres and choose fitting tags for background music from images.' },
        { role: 'user', content: prompt }
      ],
      stream: false
    });

    const result = response.data.message.content.trim();
    console.log('🎶 Music tags:', result);
    return result.split(',').map(t => t.trim()).filter(Boolean);

  } catch (err) {
    console.error('❌ LLM request error for music tags:', err.message);
    return ['emotional', 'piano', 'calm'];
  }
}



module.exports = {
  generateTitleOnly,
  generateMusicTagsOnly  // ✅ HIER rein
};
