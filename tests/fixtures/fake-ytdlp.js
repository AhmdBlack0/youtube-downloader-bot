// @ts-check
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const targetUrl = args[args.length - 1];

// Find output template (-o <template>)
const oIndex = args.indexOf('-o');
const outputTemplate = oIndex !== -1 ? args[oIndex + 1] : 'output.mp4';

// 1. Simulate hang/timeout
if (targetUrl.includes('simulate-timeout')) {
  // Hang indefinitely until parent process kills it
  setInterval(() => {}, 10000);
}
// 2. Simulate failure
else if (targetUrl.includes('simulate-fail') || targetUrl.includes('playlist_item_2')) {
  process.stderr.write('ERROR: [youtube] test_fail: This video is private.\n');
  process.exit(1);
}
// 3. Normal or oversize download simulation
else {
  const isAudio = args.includes('-x');
  const ext = isAudio ? 'mp3' : 'mp4';

  const filePath = outputTemplate.replace('%(id)s.%(ext)s', `test_video.${ext}`);
  const outputDir = path.dirname(filePath);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  process.stdout.write('PROGRESS: 50.0%|2.0MiB/s|00:01\n');
  process.stdout.write('PROGRESS: 100.0%|2.0MiB/s|00:00\n');

  const isOversize =
    targetUrl.includes('simulate-oversize') || targetUrl.includes('playlist_item_4');

  if (isOversize) {
    const fileSize = 11 * 1024 * 1024 * 1024; // 11 GB (> 10GB limit)
    const fd = fs.openSync(filePath, 'w');
    fs.ftruncateSync(fd, fileSize);
    fs.closeSync(fd);
  } else {
    fs.writeFileSync(filePath, Buffer.alloc(1024, 'dummy-video-bytes'));
  }

  if (args.includes('--write-thumbnail')) {
    const thumbPath = filePath.replace(`.${ext}`, '.jpg');
    fs.writeFileSync(thumbPath, Buffer.alloc(512, 'dummy-jpg-bytes'));
  }

  let height = isAudio ? 'NA' : '720';
  let width = isAudio ? 'NA' : '1280';
  if (targetUrl.includes('simulate-fallback-480')) {
    height = '480';
    width = '854';
  }

  process.stdout.write(`FINAL:${filePath}|${height}|${width}|120|Test Title|Test Uploader\n`);
  process.exit(0);
}
