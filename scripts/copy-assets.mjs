import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve('src', 'renderer');
const distDir = path.resolve('dist', 'renderer');

fs.mkdirSync(distDir, { recursive: true });

for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.html') || file.endsWith('.css')) {
    fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
  }
}
