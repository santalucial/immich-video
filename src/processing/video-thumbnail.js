const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { FFMPEG_PATH } = require('./ffmpeg-utils');

const generateThumbnail = (videoPath, outputFolder) => {
    return new Promise((resolve, reject) => {
        const fileName = path.basename(videoPath, path.extname(videoPath)) + '.jpg';
        const outputFilePath = path.join(outputFolder, fileName);

        // Falls Thumbnail bereits existiert, nicht nochmal generieren
        if (fs.existsSync(outputFilePath)) {
            console.log(`Thumbnail already exists: ${outputFilePath}`);
            return resolve(outputFilePath);
        }

        // FFmpeg Befehl: Extrahiert das erste Frame als JPG
        const command = `"${FFMPEG_PATH}" -i "${videoPath}" -ss 00:00:01 -vframes 1 -q:v 2 "${outputFilePath}"`;

        exec(command, (error) => {
            if (error) {
                console.error("Error generating thumbnail:", error);
                return reject(error);
            }
            console.log(`Thumbnail created: ${outputFilePath}`);
            resolve(outputFilePath);
        });
    });
};

module.exports = { generateThumbnail };
