import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const pin = JSON.parse(await fs.readFile(path.join(root, 'upstream.json'), 'utf8'));
function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
	});
}

for (const source of pin.sources) {
	const destination = path.join(root, 'vendor', source.name);
	if (await fs.stat(path.join(destination, 'CMakeLists.txt')).catch(() => null)) continue;
	const response = await fetch(source.url, { signal: AbortSignal.timeout(120000) });
	if (!response.ok) throw new Error(`Could not download ${source.name}: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`${source.name} checksum mismatch`);
	await fs.mkdir(destination, { recursive: true });
	const archive = path.join(root, 'vendor', `${source.name}.tar.gz`);
	await fs.writeFile(archive, bytes);
	await run('tar', ['xzf', archive, '--strip-components=1', '-C', destination]);
}

if (process.platform === 'win32') {
	const drive = /^([a-z]):[\\/](.*)$/i.exec(root);
	if (!drive) throw new Error('Use a checkout on a drive accessible from WSL.');
	const wslRoot = `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`;
	const quoted = "'" + wslRoot.replaceAll("'", "'\\''") + "'";
	await run('wsl.exe', ['-d', process.env.NRSC5_WSL_DISTRO || 'Ubuntu', '--', 'bash', '-lc', `source ~/emsdk/emsdk_env.sh >/dev/null 2>&1 && bash ${quoted}build.sh`]);
} else {
	await run('bash', ['build.sh']);
}
