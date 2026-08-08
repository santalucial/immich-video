// ffmpeg-utils.js
const fs = require('fs');
const { execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

function resolveBinary(envKey, binaryName, candidates) {
  const fromEnv = process.env[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const found = execSync(`command -v ${binaryName}`, { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {
    // fall through
  }

  return binaryName;
}

const FFMPEG_PATH = resolveBinary('FFMPEG_PATH', 'ffmpeg', [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
]);

const FFPROBE_PATH = resolveBinary('FFPROBE_PATH', 'ffprobe', [
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/usr/bin/ffprobe',
]);

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

function runFFmpegCommand(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const command = inputPath ? ffmpeg(inputPath) : ffmpeg();

    if (options.inputOptions) {
      command.inputOptions(options.inputOptions);
    }
    if (options.videoCodec) {
      command.videoCodec(options.videoCodec);
    }
    if (options.audioCodec) {
      command.audioCodec(options.audioCodec);
    }
    if (options.format) {
      command.format(options.format);
    }
    if (options.additionalInputs) {
      options.additionalInputs.forEach(input => {
        command.input(input.path);
        if (input.options) {
          command.inputOptions(input.options);
        }
      });
    }
    if (options.outputOptions) {
      command.outputOptions(options.outputOptions);
    }

    command
      .save(outputPath)
      .on('start', (commandLine) => {
        console.log(`FFmpeg starting: ${commandLine}`);
      })
      .on('progress', (progress) => {
        console.log(`Progress: ${Math.round(progress.percent || 0)}%`);
      })
      .on('end', () => {
        console.log(`FFmpeg succeeded: ${outputPath}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`FFmpeg error: ${err.message}`);
        console.error(`FFmpeg stderr: ${stderr}`);
        reject(err);
      });
  });
}

module.exports = { runFFmpegCommand, FFMPEG_PATH, FFPROBE_PATH };
