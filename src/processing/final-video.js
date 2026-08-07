const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { runFFmpegCommand } = require('./ffmpeg-utils');
const { processImageWithDuration } = require('./ffmpeg');
const { spawn, execSync, exec } = require('child_process');
const { sendProgressUpdate } = require('../server'); // Importiere es aus server.js
const LIVE_REPEAT_COUNT = process.env.LIVE_REPEAT_COUNT || 5;

function parseTimeStringToMs(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length !== 3) return 5000;
  const [hours, minutes, secondsParts] = parts;
  const [seconds, ms] = secondsParts.split('.').map(n => parseInt(n || '0', 10));
  return ((parseInt(hours) * 3600) + (parseInt(minutes) * 60) + seconds) * 1000 + (ms || 0);
}

function hasAudioTrack(filePath) {
  return new Promise(resolve => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    let stdout = '';
    ffprobe.stdout.on('data', data => stdout += data);
    ffprobe.on('close', () => resolve(stdout.includes('audio')));
  });
}

function hasAudioStream(filePath) {
  try {
    const output = execSync(`ffprobe -i "${filePath}" -show_streams -select_streams a -loglevel error`).toString();
    return output.includes('[STREAM]');
  } catch (err) {
    console.error('ffprobe error:', err);
    return false;
  }
}

function getDurationInSeconds(filePath) {
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    return parseFloat(output.toString().trim());
  } catch (err) {
    console.error('Duration error:', err);
    return 5;
  }
}

function ensureAudioTrack(filePath) {
  if (hasAudioStream(filePath)) return filePath;

  const duration = getDurationInSeconds(filePath);
  const silentFilePath = filePath.replace(/\.mp4$/, '_with_audio.mp4');

  if (!fs.existsSync(silentFilePath)) {
    const cmd = `ffmpeg -y -i "${filePath}" \
-f lavfi -t ${duration} -i anullsrc=channel_layout=stereo:sample_rate=48000 \
-r 25 -vsync 2 \
-c:v libx264 -preset veryfast -pix_fmt yuv420p \
-c:a aac -b:a 192k \
-shortest "${silentFilePath}"`;

    console.log(`🎙️ Adding silent audio: ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  }

  return silentFilePath;
}


async function processVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setFfmpegPath('/usr/bin/ffmpeg')
      .outputOptions([
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
        '-r', '25',
        '-vsync', '2',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest'
      ])
      .on('start', commandLine => console.log(`FFmpeg starting (video): ${commandLine}`))
      .on('end', () => {
        console.log(`✅ Video processed successfully: ${outputPath}`);
        resolve();
      })
      .on('error', err => {
        console.error(`❌ Error processing video: ${err.message}`);
        reject(err);
      })
      .save(outputPath);
  });
}

async function generateFinalVideo(options, outputPath, progressCallback = () => {}) {
  try {
    if (!options || !options.media) throw new Error('Invalid export options: media is missing.');

    

const timelineAssets = options.media;
const mediaFolder = path.join(__dirname, '../../medien');
const tempFolder = path.join(__dirname, '../../temp');
if (!fs.existsSync(tempFolder)) fs.mkdirSync(tempFolder, { recursive: true });
progressCallback(`🚀 Starting video export: "${options.title || 'Untitled'}"`);
progressCallback(`🎞️ Media count: ${timelineAssets.length}`);
const processedClips = [];
const transitions = [];
let videoIndex = 0;

for (let i = 0; i < timelineAssets.length; i++) {
  const asset = timelineAssets[i];
  if (asset.type === 'TRANSITION') {
    transitions.push({
      transition: asset.transition || 'fade',
      duration: (asset.duration || 1000) / 1000
    });
    progressCallback(`🔁 Transition added: "${asset.transition}" @ Position ${i}`);
    continue;
  }

  if (!asset.downloadName) continue;

  const ext = path.extname(asset.downloadName).toLowerCase();
  const inputPath = path.join(mediaFolder, asset.downloadName);
  const clipOutput = path.join(tempFolder, `clip_${videoIndex}.mp4`);
  const durationMs = asset.duration || 5000;
  const durationSec = durationMs / 1000;

  progressCallback(`⚙️ Processing clip ${videoIndex + 1}: ${asset.downloadName}`);

  if (asset.type === 'IMAGE') {
    await processImageWithDuration(inputPath, clipOutput, durationSec);
    progressCallback(`🖼️ Image converted: ${asset.downloadName}`);
  } else {
    await processVideo(inputPath, clipOutput);
    progressCallback(`🎞️ Video processed: ${asset.downloadName}`);
  }

  const clipWithAudio = ensureAudioTrack(clipOutput);

  processedClips.push({
    clipOutput: clipWithAudio,
    duration: durationMs,
    durationSec,
    hasAudio: true
  });

  progressCallback(`📦 Clip saved (${videoIndex + 1}/${timelineAssets.length}): ${asset.downloadName}`);
  videoIndex++;
}

if (processedClips.length === 0) {
  throw new Error('❌ No clips available – cannot create video.');
}

progressCallback(`🧰 Applying transitions…`);
// Music is mixed afterwards — do not pull remote audio URLs into the transition encode.
await createFinalVideoWithTransitions(processedClips, outputPath, transitions);

if (Array.isArray(options.audio) && options.audio.length > 0 && options.audio[0].url) {
  const audioUrl = options.audio[0].url;
  const audioTempPath = path.join(tempFolder, 'temp_audio.mp3');
  const mixedOutputPath = outputPath.replace('.mp4', '_mixed.mp4');

  progressCallback(`🎵 Downloading music for mix: ${audioUrl}`);
  execSync(`curl -L "${audioUrl}" -o "${audioTempPath}"`);

  const ffmpegCmd = `ffmpeg -i "${outputPath}" -i "${audioTempPath}" \
-filter_complex "[1:a]volume=0.09[aquiet];[0:a][aquiet]amix=inputs=2:duration=first:dropout_transition=3[aout]" \
-map 0:v -map "[aout]" -c:v copy -c:a aac -shortest -y "${mixedOutputPath}"`;

  progressCallback(`🎚️ Mixing final audio track…`);
  execSync(ffmpegCmd, { stdio: 'inherit' });

  fs.renameSync(mixedOutputPath, outputPath);
  progressCallback(`✅ Final audio mix complete: ${outputPath}`);
} else {
  progressCallback(`🎧 No additional audio track – keeping clip audio.`);
}



  progressCallback(`✅ Export complete: ${outputPath}`);


progressCallback(`🧹 Cleanup finished.`);
return outputPath;


  } catch (error) {
    console.error("❌ Error in generateFinalVideo:", error);
    throw error;
  }
  
}

function cleanUnusedMedia(usedFiles = []) {
  const mediaDir = path.join(__dirname, '../../', 'medien');
  const whitelist = new Set(usedFiles);
  const validExt = ['.jpg', '.jpeg', '.png', '.mp4', '.mov'];

  fs.readdir(mediaDir, (err, files) => {
    if (err) return console.error('Error reading media folder:', err);

    files.forEach(file => {
      const ext = path.extname(file).toLowerCase();
      if (!validExt.includes(ext)) return;

      if (!whitelist.has(file)) {
        const fullPath = path.join(mediaDir, file);
        fs.unlink(fullPath, err => {
          if (err) console.error(`❌ Could not delete ${file}:`, err);
          else console.log(`🗑️ Deleted unused file: ${file}`);
        });
      }
    });
  });
}

function cleanAllMediaFiles() {
  const folders = [
    '../../medien',
    '../../medien/thumbnails',
    './medien'
  ];

  const validExt = ['.jpg', '.jpeg', '.png', '.mp4', '.mov', '.webp', '.txt'];

  folders.forEach(dir => {
    const fullPath = path.resolve(__dirname, dir);

    fs.readdir(fullPath, (err, files) => {
      if (err) return console.error(`❌ Error reading ${fullPath}:`, err);

      files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (!validExt.includes(ext)) return;

        const filePath = path.join(fullPath, file);
        fs.unlink(filePath, err => {
          if (err) console.error(`❌ Could not delete ${filePath}:`, err);
          else console.log(`🧹 Deleted: ${filePath}`);
        });
      });
    });
  });
}

function createFinalVideoWithTransitions(mediaFiles, outputPath, transitions = []) {
  let inputArgs = mediaFiles.map(file => `-i "${file.clipOutput}"`).join(' ');
  const hasTransitions = Array.isArray(transitions) && transitions.length > 0;

  const filterParts = [];
  const audioParts = [];
  let videoOut = '';
  let audioOut = '';
  let accumulatedOffset = 0;

  if (!Array.isArray(mediaFiles) || mediaFiles.length <= 1) {
    console.log("⚠️ Too few clips for transitions. No filter graph needed.");
    fs.copyFileSync(mediaFiles[0].clipOutput, outputPath);
    return;
  }

  if (!hasTransitions) {
    // 🟢 Kein Übergang – einfacher concat!
    const concatListPath = path.join(__dirname, '../../temp/concat_list.txt');
    const concatList = mediaFiles.map(f => `file '${f.clipOutput}'`).join('\n');
    fs.writeFileSync(concatListPath, concatList);
  
    const ffmpegConcatCmd = `ffmpeg -f concat -safe 0 -i "${concatListPath}" -vsync 2 -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -y "${outputPath}"`;
    console.log('[createFinalVideoWithTransitions] FFmpeg concat (no transitions):\n' + ffmpegConcatCmd);
    execSync(ffmpegConcatCmd, { stdio: 'inherit' });
  
    return;
  }
  

  for (let i = 0; i < mediaFiles.length - 1; i++) {
    const inputA = i === 0 ? `[${i}:v]` : `[v${i}]`;
    const inputB = `[${i + 1}:v]`;
    const outLabel = i === mediaFiles.length - 2 ? 'vout' : `v${i + 1}`;
    
    const inputA_a = i === 0 ? `[${i}:a]` : `[a${i}]`;
    const inputB_a = `[${i + 1}:a]`;
    const outLabelA = i === mediaFiles.length - 2 ? 'aout' : `a${i + 1}`;

    // 🔥 Berechne dynamisch die Übergangsdauer
    const trans = transitions[i] || {};
    let transType = trans.transition || 'fade';
    const durA = mediaFiles[i].durationSec;
    const durB = mediaFiles[i + 1].durationSec;
    let transDuration = Math.min((trans.duration || 1), durA, durB, 2); // max. 2s oder so

    // 🧠 Offset ist Clip A komplett - Übergangsdauer
    const offset = accumulatedOffset + durA - transDuration;

    filterParts.push(`${inputA}${inputB}xfade=transition=${transType}:duration=${transDuration.toFixed(2)}:offset=${offset.toFixed(2)}[${outLabel}]`);
    audioParts.push(`${inputA_a}${inputB_a}acrossfade=d=${transDuration.toFixed(2)}:c1=exp:c2=exp[${outLabelA}]`);

    accumulatedOffset = offset;
    videoOut = `[${outLabel}]`;
    audioOut = `[${outLabelA}]`;
  }

  let finalVideoOut = videoOut;
let finalAudioOut = audioOut;

if (mediaFiles.length > transitions.length + 1) {
  const lastIndex = mediaFiles.length - 1;

  // letzte Clip-Datei anhängen
  filterParts.push(`${videoOut}[${lastIndex}:v]concat=n=2:v=1:a=0[vout_final]`);
  audioParts.push(`${audioOut}[${lastIndex}:a]concat=n=2:v=0:a=1[aout_final]`);

  finalVideoOut = '[vout_final]';
  finalAudioOut = '[aout_final]';
}

const filterComplex = [...filterParts, ...audioParts].join('; ');
const ffmpegCommand = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -map "${finalVideoOut}" -map "${finalAudioOut}" -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 192k -y "${outputPath}"`;

  console.log('[createFinalVideoWithTransitions] FFmpeg Command:\n' + ffmpegCommand);
  execSync(ffmpegCommand, { stdio: 'inherit' });

  const tempDir = path.join(__dirname, '../../temp');
  fs.readdirSync(tempDir).forEach(file => {
    if (file.endsWith('.mp4') || file.endsWith('.txt')) {
      try {
        fs.unlinkSync(path.join(tempDir, file));
      } catch (err) {
        console.warn(`⚠️ Error deleting ${file}`);
      }
    }
  });

  console.log('✅ Export complete:', outputPath);
}


module.exports = { generateFinalVideo, generateVideo: generateFinalVideo };
