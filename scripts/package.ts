import { existsSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, '..');
if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('请先执行 bun run build。');
const parent = resolve(tmpdir());
const staging = mkdtempSync(join(parent, 'vectra-package-'));
const output = resolve(root, 'dist/vectra-1.0.3-source.zip'); mkdirSync(join(root, 'dist'), { recursive: true });
try {
  for (const file of ['package.json', 'bun.lock', 'tsconfig.json', '.env.example', 'README.md', '.gitignore']) cpSync(join(root, file), join(staging, file));
  for (const folder of ['apps', 'packages', 'scripts', 'docs', '.github']) cpSync(join(root, folder), join(staging, folder), { recursive: true, filter: path => !/(?:^|[\\/])(?:node_modules|runtime[^\\/]*|\.env|\.git)(?:[\\/]|$)/.test(path) });
  mkdirSync(join(staging, 'logs'), { recursive: true });
  cpSync(join(root, 'logs/README.md'), join(staging, 'logs/README.md'));
  if (process.platform === 'win32') {
    const child = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:VECTRA_PACKAGE_STAGE -Force | Select-Object -ExpandProperty FullName) -DestinationPath $env:VECTRA_PACKAGE_OUTPUT -Force"], { env: { ...process.env, VECTRA_PACKAGE_STAGE: staging, VECTRA_PACKAGE_OUTPUT: output }, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited) throw new Error('源码打包失败。');
  } else {
    const child = Bun.spawn(['zip', '-qr', output, '.'], { cwd: staging, stdout: 'inherit', stderr: 'inherit' }); if (await child.exited) throw new Error('源码打包需要 zip 命令。');
  }
  console.log(`已创建：${output}`);
} finally { if (resolve(staging).startsWith(join(parent, 'vectra-package-'))) rmSync(staging, { recursive: true, force: true }); }
