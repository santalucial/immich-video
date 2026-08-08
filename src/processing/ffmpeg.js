const { runFFmpegCommand, FFMPEG_PATH } = require('./ffmpeg-utils');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const exifParser = require('exif-parser');

const HEIC_EXT = new Set(['.heic', '.heif', '.hif']);

function getImageRotation(inputPath) {
  try {
    const buffer = fs.readFileSync(inputPath);
    const parser = exifParser.create(buffer);
    const result = parser.parse();
    return result.tags.Orientation || 1; // Standard: normal
  } catch (err) {
    console.error('EXIF error:', err.message);
    return 1; // Fallback auf normal
  }
}

function isHeicLike(filePath) {
  return HEIC_EXT.has(path.extname(filePath).toLowerCase());
}

function commandExists(binary) {
  const candidates = [
    `/usr/bin/${binary}`,
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
  ];
  if (candidates.some((p) => fs.existsSync(p))) return true;
  try {
    execFileSync('which', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Newer iPhone HEICs (HDR gain maps / tmap) open as mov in FFmpeg, so -loop fails.
 * Convert to JPEG first via sips (macOS) or heif-convert.
 */
function convertHeicToJpeg(inputPath) {
  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const jpegPath = path.join(
    tempDir,
    `heic_${path.basename(inputPath, path.extname(inputPath))}_${Date.now()}.jpg`
  );

  if (commandExists('sips')) {
    console.log(`🔄 Converting HEIC via sips: ${inputPath}`);
    execFileSync('sips', ['-s', 'format', 'jpeg', inputPath, '--out', jpegPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } else if (commandExists('heif-convert')) {
    console.log(`🔄 Converting HEIC via heif-convert: ${inputPath}`);
    execFileSync('heif-convert', [inputPath, jpegPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } else {
    throw new Error(
      'Cannot convert HEIC: install macOS sips or libheif (heif-convert). FFmpeg cannot loop modern HDR HEIC files.'
    );
  }

  if (!fs.existsSync(jpegPath) || fs.statSync(jpegPath).size <= 0) {
    throw new Error(`HEIC conversion produced empty file: ${jpegPath}`);
  }

  return jpegPath;
}

async function checkNVENC() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec(`"${FFMPEG_PATH}" -encoders | grep nvenc`, (error, stdout) => {
      if (error || !stdout.includes("h264_nvenc")) {
        console.warn("⚠ NVENC not available! Falling back to libx264.");
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

exports.processImageWithDuration = async (input, output, duration) => {
  let convertedPath = null;
  try {
    // Überprüfe, ob NVENC verfügbar ist
    const useNVENC = await checkNVENC();
    const encoder = 'libx264';

    let imageInput = input;
    if (isHeicLike(input)) {
      convertedPath = convertHeicToJpeg(input);
      imageInput = convertedPath;
    }

    // Lese die EXIF-Orientierung
    const orientation = getImageRotation(imageInput);
    let rotateFilter = "";
    if (orientation === 6) rotateFilter = "transpose=1,";
    if (orientation === 8) rotateFilter = "transpose=2,";
    if (orientation === 3) rotateFilter = "transpose=2,transpose=2,";

    // Bildverarbeitung: Skalierung, Padding & Farbraum-Fix
    const videoFilter = `${rotateFilter}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;

    console.log(`📷 Processing image ${imageInput} -> ${output} with ${encoder}`);

    await runFFmpegCommand(imageInput, output, {
      inputOptions: ['-loop', '1', '-noautorotate'],
      videoCodec: encoder,
      outputOptions: [
        '-t', duration.toString(),
        '-vf', videoFilter,
        '-pix_fmt', 'yuv420p'
      ]
    });

  } catch (error) {
    console.error("❌ Error rendering image:", error);
    throw error;
  } finally {
    if (convertedPath) {
      try { fs.unlinkSync(convertedPath); } catch { /* ignore */ }
    }
  }
};
