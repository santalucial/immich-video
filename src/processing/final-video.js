const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { runFFmpegCommand, FFMPEG_PATH, FFPROBE_PATH } = require('./ffmpeg-utils');
const { processImageWithDuration, manualRotationFilter } = require('./ffmpeg');
const { spawn, execSync, exec } = require('child_process');
const LIVE_REPEAT_COUNT = process.env.LIVE_REPEAT_COUNT || 5;
const CLIP_CONCURRENCY = Math.max(1, parseInt(process.env.CLIP_CONCURRENCY || '2', 10));

/** Music volume 0–1. Accepts fraction (0.5) or percent (50). Default 50%. */
function parseMusicVolume(raw, fallback = 0.5) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > 1) return Math.min(1, n / 100);
  return n;
}

function getDefaultMusicVolume() {
  return parseMusicVolume(process.env.MUSIC_VOLUME, 0.5);
}

/** Multiplier for original clip/video audio. Default 1 (no change). */
function parseAudioBoost(raw, fallback = 1) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function getVideoAudioBoost() {
  return parseAudioBoost(process.env.VIDEO_AUDIO_BOOST, 1);
}

function parseTimeStringToMs(timeStr) {
  const parts = timeStr.split(':');
  if (parts.length !== 3) return 5000;
  const [hours, minutes, secondsParts] = parts;
  const [seconds, ms] = secondsParts.split('.').map(n => parseInt(n || '0', 10));
  return ((parseInt(hours) * 3600) + (parseInt(minutes) * 60) + seconds) * 1000 + (ms || 0);
}

function hasAudioTrack(filePath) {
  return new Promise(resolve => {
    const ffprobe = spawn(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    let stdout = '';
    ffprobe.stdout.on('data', data => stdout += data);
    ffprobe.on('close', () => resolve(stdout.includes('audio')));
  });
}

function hasAudioStream(filePath) {
  try {
    const output = execSync(`"${FFPROBE_PATH}" -i "${filePath}" -show_streams -select_streams a -loglevel error`).toString();
    return output.includes('[STREAM]');
  } catch (err) {
    console.error('ffprobe error:', err);
    return false;
  }
}

function getDurationInSeconds(filePath) {
  try {
    const output = execSync(`"${FFPROBE_PATH}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
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
    const cmd = `"${FFMPEG_PATH}" -y -i "${filePath}" \
-f lavfi -t ${duration} -i anullsrc=channel_layout=stereo:sample_rate=48000 \
-r 25 -fps_mode cfr \
-c:v libx264 -preset veryfast -pix_fmt yuv420p \
-c:a aac -b:a 192k \
-shortest "${silentFilePath}"`;

    console.log(`🎙️ Adding silent audio: ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  }

  return silentFilePath;
}


/** Per-clip volume 0–1. Accepts fraction (0.5) or percent (50). Default 1 (unchanged). */
function parseClipVolume(raw, fallback = 1) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > 1) return Math.min(1, n / 100);
  return n;
}

function buildVideoFilter(rotationDegrees = 0, speed = 1) {
  const parts = [];
  const rotate = manualRotationFilter(rotationDegrees);
  if (rotate) parts.push(rotate);
  parts.push('scale=1920:1080:force_original_aspect_ratio=decrease');
  parts.push('pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
  parts.push('setsar=1');
  if (Math.abs(speed - 1) >= 0.001) {
    parts.push(`setpts=PTS/${speed.toFixed(4)}`);
  }
  // Always finish as browser-safe 4:2:0 (xfade otherwise can promote to yuv444p/HDR)
  parts.push('format=yuv420p');
  return parts.join(',');
}

/** atempo only accepts 0.5–2.0; chain filters for other rates. */
function buildAtempoFilter(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2 + 1e-6) {
    filters.push('atempo=2.0');
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-6) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) >= 1e-3) {
    filters.push(`atempo=${remaining.toFixed(4)}`);
  }
  return filters.join(',');
}

function parseClipSpeed(raw, fallback = 1) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(4, Math.max(0.25, n));
}

async function processVideo(inputPath, outputPath, { trimStartSec = 0, durationSec, rotationDegrees = 0, speed = 1 } = {}) {
  const playbackSpeed = parseClipSpeed(speed, 1);
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath);

    // Keep display-matrix autorotate as the upright baseline; user rotation is extra on top.
    // Without this being explicit, some builds skip autorotate when a custom -vf is set.
    command.inputOptions(['-autorotate']);

    if (trimStartSec > 0) {
      command.seekInput(trimStartSec);
    }
    if (durationSec != null && durationSec > 0) {
      command.duration(durationSec);
    }

    const outputOptions = [
      '-vf', buildVideoFilter(rotationDegrees, playbackSpeed),
      '-r', '25',
      '-fps_mode', 'cfr',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'high',
      '-level', '4.0',
      '-shortest'
    ];

    const atempo = buildAtempoFilter(playbackSpeed);
    if (hasAudioStream(inputPath)) {
      if (atempo) outputOptions.push('-af', atempo);
      outputOptions.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      outputOptions.push('-an');
    }

    command
      .outputOptions(outputOptions)
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

/** Bake per-clip volume into a processed clip (after ensureAudioTrack). */
function applyClipVolume(filePath, volume) {
  const vol = parseClipVolume(volume, 1);
  if (Math.abs(vol - 1) < 0.001) return filePath;

  const outPath = filePath.replace(/\.mp4$/i, `_vol.mp4`);
  const cmd = `"${FFMPEG_PATH}" -y -i "${filePath}" -filter:a "volume=${vol.toFixed(3)}" -c:v copy -c:a aac -b:a 192k "${outPath}"`;
  console.log(`🔊 Clip volume ×${vol.toFixed(2)}: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  fs.renameSync(outPath, filePath);
  return filePath;
}

function resolveAudioLocalPath(track, tempFolder, index) {
  const url = track.url || track.src || '';
  if (!url) return null;

  // Local upload served as /uploads/audio/<file>
  if (url.startsWith('/uploads/') || url.startsWith('uploads/')) {
    const rel = url.replace(/^\//, '');
    const localPath = path.join(__dirname, '../../', rel);
    if (fs.existsSync(localPath)) return localPath;
  }

  if (track.localPath) {
    const localPath = path.isAbsolute(track.localPath)
      ? track.localPath
      : path.join(__dirname, '../../', track.localPath);
    if (fs.existsSync(localPath)) return localPath;
  }

  // Remote URL — download to temp
  if (/^https?:\/\//i.test(url)) {
    const ext = path.extname(new URL(url).pathname) || '.mp3';
    const dest = path.join(tempFolder, `music_${index}${ext}`);
    execSync(`curl -L "${url}" -o "${dest}"`);
    return dest;
  }

  return null;
}

async function mixMusicTracks(videoPath, tracks, tempFolder, progressCallback = () => {}) {
  const validTracks = (tracks || []).filter(t => t && (t.url || t.src || t.localPath));
  if (validTracks.length === 0) return false;

  const musicPaths = [];
  for (let i = 0; i < validTracks.length; i++) {
    progressCallback(`🎵 Preparing music track ${i + 1}/${validTracks.length}…`);
    const localPath = resolveAudioLocalPath(validTracks[i], tempFolder, i);
    if (!localPath) {
      console.warn(`Skipping music track ${i}: could not resolve source`);
      continue;
    }
    musicPaths.push({ path: localPath, track: validTracks[i] });
  }

  if (musicPaths.length === 0) return false;

  const mixedOutputPath = videoPath.replace(/\.mp4$/i, '_mixed.mp4');
  const inputArgs = [`-i "${videoPath}"`, ...musicPaths.map(m => `-i "${m.path}"`)].join(' ');

  const videoBoost = getVideoAudioBoost();
  const filterParts = [`[0:a]volume=${videoBoost.toFixed(3)}[va]`];
  const mixLabels = ['[va]'];

  musicPaths.forEach((m, i) => {
    const inputIdx = i + 1;
    const startSec = Math.max(0, Number(m.track.start) || 0);
    const durationSec = Math.max(0.1, Number(m.track.duration) || getDurationInSeconds(m.path));
    const defaultVol = getDefaultMusicVolume();
    const volume = parseMusicVolume(
      m.track.volume != null ? m.track.volume : defaultVol,
      defaultVol
    );
    const delayMs = Math.round(startSec * 1000);
    const label = `music${i}`;

    // atrim → volume → adelay (stereo: left|right) → asetpts
    filterParts.push(
      `[${inputIdx}:a]atrim=0:${durationSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)},adelay=${delayMs}|${delayMs}[${label}]`
    );
    mixLabels.push(`[${label}]`);
  });

  const amixInputs = mixLabels.length;
  filterParts.push(
    `${mixLabels.join('')}amix=inputs=${amixInputs}:duration=first:dropout_transition=3[aout]`
  );

  const ffmpegCmd = `"${FFMPEG_PATH}" ${inputArgs} -filter_complex "${filterParts.join(';')}" \
-map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -shortest -y "${mixedOutputPath}"`;

  progressCallback(`🎚️ Mixing ${musicPaths.length} music track(s) (video audio ×${videoBoost.toFixed(2)})…`);
  console.log('[mixMusicTracks]', ffmpegCmd);
  execSync(ffmpegCmd, { stdio: 'inherit' });
  // Replace in place via copy so readers of the old inode are less likely to 416
  fs.copyFileSync(mixedOutputPath, videoPath);
  try { fs.unlinkSync(mixedOutputPath); } catch { /* ignore */ }
  return true;
}

async function applyVideoAudioBoost(videoPath, progressCallback = () => {}) {
  const boost = getVideoAudioBoost();
  if (Math.abs(boost - 1) < 0.001) return false;

  const boostedPath = videoPath.replace(/\.mp4$/i, '_boosted.mp4');
  const ffmpegCmd = `"${FFMPEG_PATH}" -i "${videoPath}" -filter:a "volume=${boost.toFixed(3)}" -c:v copy -c:a aac -b:a 192k -y "${boostedPath}"`;

  progressCallback(`🔊 Applying video audio boost ×${boost.toFixed(2)}…`);
  console.log('[applyVideoAudioBoost]', ffmpegCmd);
  execSync(ffmpegCmd, { stdio: 'inherit' });
  fs.renameSync(boostedPath, videoPath);
  return true;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => run());
  await Promise.all(runners);
  return results;
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
const transitions = [];
const clipJobs = [];

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

  const videoIndex = clipJobs.length;
  const inputPath = path.join(mediaFolder, asset.downloadName);
  const clipOutput = path.join(tempFolder, `clip_${videoIndex}.mp4`);
  const durationMs = asset.duration || 5000;
  const durationSec = durationMs / 1000;
  const trimStartSec = Math.max(0, (Number(asset.trimStartMs) || 0) / 1000);

  clipJobs.push({
    asset,
    videoIndex,
    inputPath,
    clipOutput,
    durationMs,
    durationSec,
    trimStartSec
  });
}

if (clipJobs.length === 0) {
  throw new Error('❌ No clips available – cannot create video.');
}

progressCallback(`⚙️ Encoding ${clipJobs.length} clip(s) (concurrency ${CLIP_CONCURRENCY})…`);

const { isUsableLocalFile } = require('./immich-api');
const missing = clipJobs.filter((job) => !isUsableLocalFile(job.inputPath));
if (missing.length) {
  const names = missing.slice(0, 5).map((j) => j.asset.downloadName).join(', ');
  const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
  throw new Error(
    `Media missing, empty, or corrupt (${missing.length}): ${names}${more}. Re-run export after Immich downloads succeed.`
  );
}

const processedClips = await mapWithConcurrency(clipJobs, CLIP_CONCURRENCY, async (job) => {
  const { asset, inputPath, clipOutput, durationMs, durationSec, trimStartSec, videoIndex } = job;
  progressCallback(`⚙️ Processing clip ${videoIndex + 1}/${clipJobs.length}: ${asset.downloadName}`);

  const rotationDegrees = Number(asset.rotation) || 0;
  const clipVolume = parseClipVolume(asset.volume, 1);
  const clipSpeed = parseClipSpeed(asset.speed, 1);

  if (asset.type === 'IMAGE') {
    await processImageWithDuration(inputPath, clipOutput, durationSec, { rotationDegrees });
    progressCallback(`🖼️ Image converted: ${asset.downloadName}${rotationDegrees ? ` (rotate ${rotationDegrees}°)` : ''}`);
  } else {
    await processVideo(inputPath, clipOutput, {
      trimStartSec,
      durationSec,
      rotationDegrees,
      speed: clipSpeed
    });
    progressCallback(
      `🎞️ Video processed: ${asset.downloadName} (trim ${trimStartSec.toFixed(2)}s, ${durationSec.toFixed(2)}s` +
      `${clipSpeed !== 1 ? `, ${clipSpeed}x` : ''}` +
      `${rotationDegrees ? `, rotate ${rotationDegrees}°` : ''})`
    );
  }

  let clipWithAudio = ensureAudioTrack(clipOutput);
  clipWithAudio = applyClipVolume(clipWithAudio, clipVolume);
  progressCallback(`📦 Clip saved (${videoIndex + 1}/${clipJobs.length}): ${asset.downloadName}`);

  return {
    clipOutput: clipWithAudio,
    duration: durationMs,
    durationSec,
    hasAudio: true
  };
});

progressCallback(`🧰 Applying transitions…`);
// Music is mixed afterwards — do not pull remote audio URLs into the transition encode.
await createFinalVideoWithTransitions(processedClips, outputPath, transitions);

const mixed = await mixMusicTracks(outputPath, options.audio, tempFolder, progressCallback);
if (mixed) {
  progressCallback(`✅ Final audio mix complete: ${outputPath}`);
} else {
  const boosted = await applyVideoAudioBoost(outputPath, progressCallback);
  if (boosted) {
    progressCallback(`✅ Video audio boost applied: ${outputPath}`);
  } else {
    progressCallback(`🎧 No additional audio track – keeping clip audio.`);
  }
}

  progressCallback(`✅ Export complete: ${outputPath}`);
  progressCallback(`EXPORT_DONE:${outputPath}`);

progressCallback(`🧹 Cleanup finished.`);
return outputPath;


  } catch (error) {
    console.error("❌ Error in generateFinalVideo:", error);
    progressCallback(`❌ Export failed: ${error.message}`);
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
  
    const ffmpegConcatCmd = `"${FFMPEG_PATH}" -f concat -safe 0 -i "${concatListPath}" -r 25 -fps_mode cfr -pix_fmt yuv420p -c:v libx264 -preset fast -crf 23 -profile:v high -level 4.0 -c:a aac -b:a 192k -y "${outputPath}"`;
    console.log('[createFinalVideoWithTransitions] FFmpeg concat (no transitions):\n' + ffmpegConcatCmd);
    execSync(ffmpegConcatCmd, { stdio: 'inherit' });
  
    return;
  }
  

  // Normalize SAR + pixel format so xfade never promotes to yuv444p / odd HDR formats
  for (let i = 0; i < mediaFiles.length; i++) {
    filterParts.push(`[${i}:v]setsar=1,format=yuv420p[vn${i}]`);
  }

  for (let i = 0; i < mediaFiles.length - 1; i++) {
    const inputA = i === 0 ? `[vn${i}]` : `[v${i}]`;
    const inputB = `[vn${i + 1}]`;
    const outLabel = i === mediaFiles.length - 2 ? 'vout' : `v${i + 1}`;

    const inputA_a = i === 0 ? `[${i}:a]` : `[a${i}]`;
    const inputB_a = `[${i + 1}:a]`;
    const outLabelA = i === mediaFiles.length - 2 ? 'aout' : `a${i + 1}`;

    const trans = transitions[i] || {};
    const transType = trans.transition || 'fade';
    const durA = mediaFiles[i].durationSec;
    const durB = mediaFiles[i + 1].durationSec;
    const transDuration = Math.min((trans.duration || 1), durA, durB, 2);

    const offset = accumulatedOffset + durA - transDuration;

    filterParts.push(`${inputA}${inputB}xfade=transition=${transType}:duration=${transDuration.toFixed(2)}:offset=${offset.toFixed(2)}[${outLabel}]`);
    audioParts.push(`${inputA_a}${inputB_a}acrossfade=d=${transDuration.toFixed(2)}:c1=exp:c2=exp[${outLabelA}]`);

    accumulatedOffset = offset;
    videoOut = `[${outLabel}]`;
    audioOut = `[${outLabelA}]`;
  }

  // xfade/acrossfade already include every clip — do not re-append the last one via concat
  const filterComplex = [...filterParts, ...audioParts].join('; ');
  const ffmpegCommand = `"${FFMPEG_PATH}" ${inputArgs} -filter_complex "${filterComplex}" -map "${videoOut}" -map "${audioOut}" -c:v libx264 -pix_fmt yuv420p -crf 23 -preset fast -profile:v high -level 4.0 -c:a aac -b:a 192k -y "${outputPath}"`;

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

  console.log('✅ Timeline render complete:', outputPath);
}


module.exports = { generateFinalVideo, generateVideo: generateFinalVideo };
