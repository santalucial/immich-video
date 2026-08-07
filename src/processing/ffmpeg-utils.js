// ffmpeg-utils.js
const ffmpeg = require('fluent-ffmpeg');

function runFFmpegCommand(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    // Erstelle den ffmpeg-Befehl
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

    // Starte ffmpeg
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

module.exports = { runFFmpegCommand };
