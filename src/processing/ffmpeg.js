const { runFFmpegCommand, FFMPEG_PATH } = require('./ffmpeg-utils');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const exifParser = require('exif-parser');

const HEIC_EXT = new Set(['.heic', '.heif', '.hif']);
/** Still-image encodes that never finish (common with broken HEIC→JPEG). */
const IMAGE_FFMPEG_TIMEOUT_MS = Number(process.env.IMAGE_FFMPEG_TIMEOUT_MS) || 120_000;

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

/** Manual user rotation in degrees clockwise (0/90/180/270). Returns ffmpeg vf fragment or ''. */
function manualRotationFilter(degrees) {
  const d = ((Number(degrees) % 360) + 360) % 360;
  // Symbolic dirs match CSS rotate() (positive = clockwise)
  if (d === 90) return 'transpose=clock';
  if (d === 180) return 'hflip,vflip';
  if (d === 270) return 'transpose=cclock';
  return '';
}

exports.manualRotationFilter = manualRotationFilter;

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

function removeIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/** True when image has real pixel dimensions (sips often writes EXIF-only stubs for HDR HEIC). */
function hasUsableImageDimensions(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1024) return false;

  if (commandExists('sips')) {
    try {
      const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const width = Number((out.match(/pixelWidth:\s*(\d+)/) || [])[1]);
      const height = Number((out.match(/pixelHeight:\s*(\d+)/) || [])[1]);
      return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    } catch {
      /* fall through to ffprobe */
    }
  }

  try {
    const { FFPROBE_PATH } = require('./ffmpeg-utils');
    const out = execFileSync(
      FFPROBE_PATH,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', filePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const [w, h] = out.trim().split('x').map(Number);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  } catch {
    return false;
  }
}

function tryConvertWithSips(inputPath, jpegPath) {
  if (!commandExists('sips')) return false;
  console.log(`🔄 Converting HEIC via sips: ${inputPath}`);
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', inputPath, '--out', jpegPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn(`sips failed for ${inputPath}: ${err.message}`);
    removeIfExists(jpegPath);
    return false;
  }
  if (hasUsableImageDimensions(jpegPath)) return true;
  console.warn(`sips produced unusable JPEG (no dimensions) for ${path.basename(inputPath)}`);
  removeIfExists(jpegPath);
  return false;
}

function tryConvertWithHeifConvert(inputPath, jpegPath) {
  if (!commandExists('heif-convert')) return false;
  console.log(`🔄 Converting HEIC via heif-convert: ${inputPath}`);
  try {
    execFileSync('heif-convert', [inputPath, jpegPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn(`heif-convert failed for ${inputPath}: ${err.message}`);
    removeIfExists(jpegPath);
    return false;
  }
  if (hasUsableImageDimensions(jpegPath)) return true;
  removeIfExists(jpegPath);
  return false;
}

/**
 * macOS Quick Look can decode HDR / gain-map HEICs that sips writes as EXIF-only stubs.
 * Output is PNG; we re-encode to JPEG for the still-image pipeline.
 */
function tryConvertWithQlmanage(inputPath, jpegPath) {
  if (!commandExists('qlmanage')) return false;

  const tempDir = path.dirname(jpegPath);
  const qlDir = path.join(tempDir, `ql_${Date.now()}`);
  fs.mkdirSync(qlDir, { recursive: true });

  console.log(`🔄 Converting HEIC via qlmanage: ${inputPath}`);
  try {
    execFileSync('qlmanage', ['-t', '-s', '4032', '-o', qlDir, inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const expectedPng = path.join(qlDir, `${path.basename(inputPath)}.png`);
    const pngPath = fs.existsSync(expectedPng)
      ? expectedPng
      : fs.readdirSync(qlDir).map((f) => path.join(qlDir, f)).find((f) => /\.png$/i.test(f));

    if (!pngPath || !hasUsableImageDimensions(pngPath)) {
      console.warn(`qlmanage produced no usable PNG for ${path.basename(inputPath)}`);
      return false;
    }

    if (commandExists('sips')) {
      execFileSync('sips', ['-s', 'format', 'jpeg', pngPath, '--out', jpegPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    if (!hasUsableImageDimensions(jpegPath)) {
      // Feed PNG to ffmpeg if jpeg re-encode failed
      fs.copyFileSync(pngPath, jpegPath);
    }
    return hasUsableImageDimensions(jpegPath);
  } catch (err) {
    console.warn(`qlmanage failed for ${inputPath}: ${err.message}`);
    removeIfExists(jpegPath);
    return false;
  } finally {
    try {
      fs.rmSync(qlDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Newer iPhone HEICs (HDR gain maps / tmap) open as mov in FFmpeg, so -loop fails.
 * Convert to JPEG first. Prefer sips, then qlmanage (macOS), then heif-convert.
 */
function convertHeicToJpeg(inputPath) {
  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const jpegPath = path.join(
    tempDir,
    `heic_${path.basename(inputPath, path.extname(inputPath))}_${Date.now()}.jpg`
  );

  if (tryConvertWithSips(inputPath, jpegPath)) return jpegPath;
  if (tryConvertWithQlmanage(inputPath, jpegPath)) return jpegPath;
  if (tryConvertWithHeifConvert(inputPath, jpegPath)) return jpegPath;

  throw new Error(
    `Cannot convert HEIC ${path.basename(inputPath)}: sips/qlmanage/heif-convert all failed or produced empty frames.`
  );
}

async function checkNVENC() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec(`"${FFMPEG_PATH}" -encoders | grep nvenc`, (error, stdout) => {
      if (error || !stdout.includes('h264_nvenc')) {
        console.warn('⚠ NVENC not available! Falling back to libx264.');
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

exports.processImageWithDuration = async (input, output, duration, { rotationDegrees = 0 } = {}) => {
  let convertedPath = null;
  try {
    // Überprüfe, ob NVENC verfügbar ist
    const useNVENC = await checkNVENC();
    const encoder = 'libx264';

    let imageInput = input;
    if (isHeicLike(input)) {
      convertedPath = convertHeicToJpeg(input);
      imageInput = convertedPath;
    } else if (!hasUsableImageDimensions(imageInput)) {
      throw new Error(`Image has no usable dimensions: ${imageInput}`);
    }

    // Lese die EXIF-Orientierung
    const orientation = getImageRotation(imageInput);
    let rotateFilter = '';
    if (orientation === 6) rotateFilter = 'transpose=1,';
    if (orientation === 8) rotateFilter = 'transpose=2,';
    if (orientation === 3) rotateFilter = 'transpose=2,transpose=2,';
    // 5 / 7 are mirrored+rotated; transpose alone is imperfect but avoids wrong landscape
    if (orientation === 5) rotateFilter = 'transpose=2,';
    if (orientation === 7) rotateFilter = 'transpose=1,';

    const manualRotate = manualRotationFilter(rotationDegrees);
    if (manualRotate) rotateFilter += `${manualRotate},`;

    // Bildverarbeitung: Skalierung, Padding & Farbraum-Fix
    const videoFilter = `${rotateFilter}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;

    console.log(`📷 Processing image ${imageInput} -> ${output} with ${encoder}`);

    await runFFmpegCommand(imageInput, output, {
      // framerate before loop so -t ends; without it, 0-dimension stubs can spin forever
      inputOptions: ['-framerate', '25', '-loop', '1', '-noautorotate'],
      videoCodec: encoder,
      timeoutMs: IMAGE_FFMPEG_TIMEOUT_MS,
      outputOptions: [
        '-t', duration.toString(),
        '-r', '25',
        '-vf', videoFilter,
        '-pix_fmt', 'yuv420p',
      ],
    });
  } catch (error) {
    console.error('❌ Error rendering image:', error);
    throw error;
  } finally {
    if (convertedPath) {
      try {
        fs.unlinkSync(convertedPath);
      } catch {
        /* ignore */
      }
    }
  }
};
