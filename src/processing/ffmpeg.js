const { runFFmpegCommand } = require('./ffmpeg-utils');
const fs = require('fs');
const exifParser = require('exif-parser');

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

async function checkNVENC() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec("ffmpeg -encoders | grep nvenc", (error, stdout) => {
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
  try {
    // Überprüfe, ob NVENC verfügbar ist
    const useNVENC = await checkNVENC();
    const encoder = 'libx264';

    // Lese die EXIF-Orientierung
    const orientation = getImageRotation(input);
    let rotateFilter = "";
    if (orientation === 6) rotateFilter = "transpose=1,";
    if (orientation === 8) rotateFilter = "transpose=2,";
    if (orientation === 3) rotateFilter = "transpose=2,transpose=2,";

    // Bildverarbeitung: Skalierung, Padding & Farbraum-Fix
    const videoFilter = `${rotateFilter}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

    console.log(`📷 Processing image ${input} -> ${output} with ${encoder}`);

    return runFFmpegCommand(input, output, {
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
  }
};
