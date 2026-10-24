import { describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { encryptMirrorBackup, decryptMirrorBackup, recoveryBackupKeyFromKeychain } from "../src/services/mirrorRecoveryEncryption";
import { spawnSync } from "node:child_process";
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const raw = Buffer.from('fixture secret-free original bytes\n'), key = Buffer.alloc(32, 7), plan = 'a'.repeat(64);
const context = { planSha256: plan, shard: 'zao_signals_2027_01.csv', beforeSha256: createHash('sha256').update(raw).digest('hex') };
describe('encrypted recovery backups', () => {
    it('restores exact bytes and uses fresh authenticated nonces without plaintext', () => {
        const a = encryptMirrorBackup(raw, key, context), b = encryptMirrorBackup(raw, key, context);
        expect(a.equals(b)).toBe(false);
        expect(a.includes(raw)).toBe(false);
        expect(decryptMirrorBackup(a, key, context)).toEqual(raw);
    });
    it('refuses a wrong key, altered shard/plan, truncated/tampered ciphertext, and wrong original hash', () => {
        const encrypted = encryptMirrorBackup(raw, key, context), doc = JSON.parse(encrypted.toString());
        const attempts = [() => decryptMirrorBackup(encrypted, randomBytes(32), context), () => decryptMirrorBackup(encrypted, key, { ...context, planSha256: 'b'.repeat(64) }),
            () => decryptMirrorBackup(encrypted, key, { ...context, shard: 'zao_signals_2027_02.csv' }), () => decryptMirrorBackup(encrypted.subarray(0, -1), key, context),
            () => decryptMirrorBackup(Buffer.from(JSON.stringify({ ...doc, ciphertext: Buffer.from('tampered').toString('base64') })), key, context),
            () => encryptMirrorBackup(raw, key, { ...context, beforeSha256: 'f'.repeat(64) })];
        for (const attempt of attempts)
            expect(attempt).toThrow('MIRROR_BACKUP_REFUSED');
    });
    it('never creates a Keychain item while planning, and refuses access errors rather than exploring', () => {
        const mocked = vi.mocked(spawnSync);
        mocked.mockReset();
        mocked.mockReturnValue({ status: 44, stdout: '', stderr: 'not found' } as never);
        expect(() => recoveryBackupKeyFromKeychain(plan)).toThrow('KEYCHAIN_READ');
        expect(mocked).toHaveBeenCalledTimes(1);
        const call = mocked.mock.calls[0]!;
        expect(call[0]).toBe('/usr/bin/security');
        expect(call[1]).toEqual(['find-generic-password', '-a', 'codex-zmi-recovery', '-s', `com.yuge.codex.zmi-mirror-recovery.${plan}`, '-w']);
    });
    it('puts a newly created key only in interactive stdin, reads it back, and never overwrites an existing item', () => {
        const mocked = vi.mocked(spawnSync);
        mocked.mockReset();
        let captured = '';
        mocked.mockImplementation((_file, args, options) => {
            if (args?.[0] === '-i') {
                captured = (options as {
                    input: string;
                }).input.match(/-w ([0-9a-f]{64})/)![1]!;
                expect(args).toEqual(['-i']);
                return { status: 0, stdout: '', stderr: '' } as never;
            }
            return { status: captured ? 0 : 44, stdout: captured, stderr: '' } as never;
        });
        const loaded = recoveryBackupKeyFromKeychain(plan, true);
        expect(loaded.toString('hex')).toBe(captured);
        expect(mocked).toHaveBeenCalledTimes(3);
        expect(mocked.mock.calls.every(c => !JSON.stringify(c[1]).includes(captured))).toBe(true);
        mocked.mockClear();
        expect(recoveryBackupKeyFromKeychain(plan, true)).toEqual(loaded);
        expect(mocked).toHaveBeenCalledTimes(1);
    });
});
