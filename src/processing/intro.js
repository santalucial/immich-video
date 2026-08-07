const fs = require('fs');
const path = require('path');
const { runFFmpegCommand } = require('./ffmpeg-utils');

// Du benötigst auch den Pfad zum temporären Ordner, in dem du die Textdatei speicherst:
const tempFolder = path.join(__dirname, '../../temp');



async function createIntroClip(albumTitle, outputPath) {
  console.log(`Creating intro clip for "${albumTitle}" to ${outputPath}`);
  // Get the current date in English format
  const currentDate = new Date().toLocaleDateString('en-US');

  // Finde eine passende Schriftart auf dem System
  const fontPath = await findSystemFont();
  console.log(`Using font: ${fontPath}`);

  // Build text with real line breaks: title and date
  const multilineText = `${albumTitle}\n${currentDate}`;

  // Lege eine temporäre Textdatei an, die den Text enthält
  const textFilePath = path.join(tempFolder, 'title.txt');
  fs.writeFileSync(textFilePath, multilineText, 'utf8');

  try {
    // FFmpeg with the "color" filter as input creates a black background
    // und der drawtext-Filter fügt den Text aus der Textdatei ein.
    await runFFmpegCommand('color=c=black:s=1920x1080:d=5:r=25', outputPath, {
      inputOptions: ['-f', 'lavfi'],
      videoCodec: 'h264_nvenc',
      outputOptions: [
        '-vf',
        // Wichtig: Use drawtext with textfile=..., not text=...
        `drawtext=fontfile=${fontPath}:textfile='${textFilePath}':fontcolor=white:fontsize=48:line_spacing=50:x=(w-text_w)/2:y=(h-text_h)/2,fade=t=in:st=0:d=1,fade=t=out:st=4:d=1`,
        '-pix_fmt', 'yuv420p',
        '-r', '25',
        '-t', '5',
        '-an'
      ],
      format: 'mp4'
    });

    console.log(`Intro clip created successfully: ${outputPath}`);
  } catch (error) {
    console.error(`Error creating intro clip: ${error.message}`);
    throw error;
  }
}

async function findSystemFont() {
  const possibleFontPaths = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/ttf-dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/truetype/Arial.ttf',
    '/usr/share/fonts/TTF/Arial.ttf'
  ];
  for (const fontPath of possibleFontPaths) {
    try {
      if (fs.existsSync(fontPath)) {
        return fontPath;
      }
    } catch (error) {
      continue;
    }
  }
  return 'Sans';
}

module.exports = { createIntroClip };
