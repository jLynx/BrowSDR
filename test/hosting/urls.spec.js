import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBasePath } from '@/platform/base-path';
import { appPath, backendPath } from '@/platform/urls';

afterEach(() => vi.unstubAllEnvs());

describe('deployment paths', () => {
	it.each(['/', '/sdr/', '/radio/sdr/'])('keeps assets, navigation and backend requests under %s', (base) => {
		vi.stubEnv('BASE_URL', base);
		vi.stubEnv('VITE_BACKEND_URL', '');
		expect(appPath()).toBe(base);
		expect(appPath('wasm/rtl433/rtl433.wasm')).toBe(base + 'wasm/rtl433/rtl433.wasm');
		expect(appPath('/whisper-worker.js')).toBe(base + 'whisper-worker.js');
		expect(backendPath('api/turn')).toBe(base + 'api/turn');
		expect(new URL(appPath() + '?connect=ABC', 'https://example.org').href).toBe(`https://example.org${base}?connect=ABC`);
	});

	it.each(['/backend', 'https://backend.example.org/radio'])('supports a separate backend at %s', (base) => {
		vi.stubEnv('BASE_URL', '/sdr/');
		vi.stubEnv('VITE_BACKEND_URL', base);
		expect(appPath('icon-192.png')).toBe('/sdr/icon-192.png');
		expect(backendPath('hf-proxy')).toBe(base + '/hf-proxy');
	});

	it('normalizes directory paths', () => {
		expect(normalizeBasePath()).toBe('/');
		expect(normalizeBasePath('/sdr')).toBe('/sdr/');
	});

	it.each(['./', 'sdr', 'https://example.org/sdr/', '//example.org/', '/sdr?x', '/sdr#x', '/sdr/../', '/sdr\\'])(
		'rejects unsupported base %s',
		(base) => {
			expect(() => normalizeBasePath(base)).toThrow('absolute directory path');
		},
	);
});
