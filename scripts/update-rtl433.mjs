import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const pinPath = path.join(root, 'wasm/rtl433/upstream.json');
const candidatePath = path.join(root, 'wasm/rtl433/update-pin.json');
const assetDir = path.join(root, 'wasm/rtl433/pkg');
const assets = ['rtl433.js', 'rtl433.wasm', 'COPYING', 'NOTICE'];
const args = process.argv.slice(2);

function run(command, argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, { cwd: root, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
	});
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function build(pin) {
	if (process.platform === 'win32') {
		// Use the existing WSL Emscripten installation without requiring Bash on PATH.
		const drive = /^([a-z]):[\\/](.*)$/i.exec(root);
		if (!drive) throw new Error('The Windows checkout must be on a drive accessible from WSL.');
		const wslRoot = `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`;
		const wslPin = `${wslRoot}${path.relative(root, pin).replaceAll('\\', '/')}`;
		const script = `source ~/emsdk/emsdk_env.sh >/dev/null 2>&1 && cd ${shellQuote(wslRoot)} && bash wasm/rtl433/build.sh ${shellQuote(wslPin)}`;
		await run('wsl.exe', ['-d', process.env.RTL433_WSL_DISTRO || 'Ubuntu', '--', 'bash', '-lc', script]);
	} else {
		await run('bash', ['wasm/rtl433/build.sh', pin]);
	}
}

async function request(url) {
	const response = await fetch(url, { headers: { 'User-Agent': 'BrowSDR-rtl433-update' }, signal: AbortSignal.timeout(120000) });
	if (!response.ok) throw new Error(`Upstream request failed (${response.status}): ${url}`);
	return response;
}

async function main() {
	if (args.includes('--help')) {
		console.log('Usage: npm run check:rtl433 | npm run update:rtl433 [-- --ref tag-or-commit] | npm run build:rtl433');
		return;
	}
	const refIndex = args.indexOf('--ref');
	const ref = refIndex === -1 ? 'master' : args[refIndex + 1];
	if (
		!ref ||
		ref.startsWith('--') ||
		args.some((arg, i) => !['--check', '--build', '--ref'].includes(arg) && !(refIndex !== -1 && i === refIndex + 1))
	) {
		throw new Error('Invalid arguments. Use --help for usage.');
	}
	if (args.includes('--check') && args.includes('--build')) throw new Error('Choose either --check or --build.');
	if (args.includes('--build') && refIndex !== -1) throw new Error('Use update:rtl433 with --ref to select a different revision.');
	const originalPin = await fs.readFile(pinPath);
	const pin = JSON.parse(originalPin);
	let candidate = pin;
	if (!args.includes('--build')) {
		const upstream = await (await request(`https://api.github.com/repos/merbanan/rtl_433/commits/${encodeURIComponent(ref)}`)).json();
		if (!/^[a-f0-9]{40}$/.test(upstream.sha)) throw new Error('Upstream returned an invalid commit.');
		console.log(`Bundled:  ${pin.commit}\nUpstream: ${upstream.sha} (${ref})`);
		if (args.includes('--check')) {
			console.log(
				upstream.sha === pin.commit ? 'rtl_433 is up to date.' : 'Update available. Run npm run update:rtl433 to build and validate it.',
			);
			return;
		}
		if (upstream.sha === pin.commit) {
			console.log('rtl_433 is already up to date. Use npm run build:rtl433 to rebuild.');
			return;
		}
		const archive = Buffer.from(await (await request(`https://codeload.github.com/merbanan/rtl_433/tar.gz/${upstream.sha}`)).arrayBuffer());
		candidate = { ...pin, commit: upstream.sha, sha256: createHash('sha256').update(archive).digest('hex') };
		await fs.writeFile(path.join(root, 'wasm/rtl433/source.tar.gz'), archive);
	}
	const previous = await Promise.all(assets.map((name) => fs.readFile(path.join(assetDir, name))));
	await fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2) + '\n');
	try {
		await build(candidatePath);
		// Validate the produced binary itself and the Rust-to-decoder streaming path.
		await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'client', 'test/decoders/rtl433.spec.js']);
		await fs.writeFile(pinPath, JSON.stringify(candidate, null, 2) + '\n');
		console.log(`Built and validated rtl_433 ${candidate.commit}. Review and commit the pin and wasm/rtl433/pkg assets together.`);
	} catch (error) {
		await Promise.all(assets.map((name, i) => fs.writeFile(path.join(assetDir, name), previous[i])));
		await fs.writeFile(pinPath, originalPin);
		throw new Error(`Update failed; the previous decoder assets and pin were restored. ${error.message}`, { cause: error });
	} finally {
		await fs.rm(candidatePath, { force: true });
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
