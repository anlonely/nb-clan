const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'miniprogram');
const checkedExtensions = new Set(['.js', '.json', '.wxml', '.wxss']);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : [target];
  });
}

const errors = [];
let checked = 0;

for (const filePath of sourceFiles(sourceRoot)) {
  const extension = path.extname(filePath);
  if (!checkedExtensions.has(extension)) continue;
  checked += 1;
  const relativePath = path.relative(projectRoot, filePath);
  const source = fs.readFileSync(filePath, 'utf8');
  try {
    if (!source.trim()) throw new Error('文件为空');
    if (/^(?:<{7}|={7}|>{7})/m.test(source)) throw new Error('包含未解决的合并冲突标记');
    if (extension === '.js') new vm.Script(source, { filename: relativePath });
    if (extension === '.json') JSON.parse(source);
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`小程序静态检查通过：${checked} 个源码文件`);
}
