import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url));
const json = (path: string) => JSON.parse(read(path).toString());
// The only permitted CSP change from p3-stack is the WASM execution token.
const previousCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost https: data: blob:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'";

describe('rhwp offline packaging', () => {
  it('pins the sole renderer dependency and its lock entry to MIT 0.8.7', () => {
    expect(json('package.json').dependencies['@rhwp/core']).toBe('0.8.7');
    const lock = json('package-lock.json');
    expect(lock.packages[''].dependencies['@rhwp/core']).toBe('0.8.7');
    expect(lock.packages['node_modules/@rhwp/core']).toMatchObject({ version: '0.8.7', license: 'MIT' });
    expect(json('node_modules/@rhwp/core/package.json')).toMatchObject({ version: '0.8.7', license: 'MIT' });
  });

  it('ships the package WASM byte for byte in public for same-origin loading', () => {
    const shipped = read('public/rhwp_bg.wasm');
    expect(shipped.byteLength).toBeGreaterThan(0);
    expect(shipped.equals(read('node_modules/@rhwp/core/rhwp_bg.wasm'))).toBe(true);
    expect([...shipped.subarray(0, 4)]).toEqual([0, 97, 115, 109]);
  });

  it('adds only wasm-unsafe-eval to the existing CSP', () => {
    expect(json('src-tauri/tauri.conf.json').app.security.csp).toBe(
      previousCsp.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"),
    );
  });

  it('credits rhwp and includes its MIT permission notice', () => {
    const notice = read('NOTICE').toString();
    expect(notice).toContain('@rhwp/core 0.8.7');
    expect(notice).toMatch(/https:\/\/github\.com\/[^\s]*rhwp/);
    expect(notice).toContain('MIT License');
    expect(notice).toContain('Permission is hereby granted, free of charge');
  });
});
