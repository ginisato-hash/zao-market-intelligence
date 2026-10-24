// Local recovery backups only. Never stores key material in argv, files, reports, or source history.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const refused = (why: string): never => { throw new Error(`MIRROR_BACKUP_REFUSED(${why})`); };
export interface MirrorBackupContext {
    planSha256: string;
    shard: string;
    beforeSha256: string;
}
function aad(c: MirrorBackupContext): Buffer {
    if (!/^[0-9a-f]{64}$/u.test(c.planSha256) || !/^[0-9a-f]{64}$/u.test(c.beforeSha256)
        || !/^zao_signals_\d{4}_\d{2}\.csv$/u.test(c.shard))
        refused("CONTEXT");
    return Buffer.from(JSON.stringify({ kind: "ZMI_ENCRYPTED_MIRROR_BACKUP_V1", planSha256: c.planSha256, shard: c.shard, beforeSha256: c.beforeSha256 }));
}
export function encryptMirrorBackup(raw: Buffer, key: Buffer, context: MirrorBackupContext): Buffer {
    if (key.length !== 32 || raw.length > 32 * 1024 * 1024 || sha(raw) !== context.beforeSha256)
        refused("KEY_OR_PLAINTEXT");
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
    return Buffer.from(JSON.stringify({ kind: "ZMI_ENCRYPTED_MIRROR_BACKUP_V1", keyIdSha256: sha(key),
        nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") }));
}
export function decryptMirrorBackup(encrypted: Buffer, key: Buffer, context: MirrorBackupContext): Buffer {
    if (key.length !== 32 || encrypted.length > 45 * 1024 * 1024)
        return refused("ENVELOPE_BUDGET");
    try {
        const doc = JSON.parse(encrypted.toString("utf8")) as Record<string, unknown>;
        if (doc.kind !== "ZMI_ENCRYPTED_MIRROR_BACKUP_V1" || doc.keyIdSha256 !== sha(key)
            || typeof doc.nonce !== "string" || !/^[0-9a-f]{24}$/u.test(doc.nonce)
            || typeof doc.tag !== "string" || !/^[0-9a-f]{32}$/u.test(doc.tag)
            || typeof doc.ciphertext !== "string")
            return refused("ENVELOPE");
        const ciphertext = Buffer.from(doc.ciphertext, "base64");
        if (ciphertext.toString("base64") !== doc.ciphertext || ciphertext.length > 32 * 1024 * 1024)
            return refused("CIPHERTEXT");
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(doc.nonce, "hex"));
        decipher.setAAD(aad(context));
        decipher.setAuthTag(Buffer.from(doc.tag, "hex"));
        const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (sha(raw) !== context.beforeSha256)
            return refused("PLAINTEXT_HASH");
        return raw;
    }
    catch {
        return refused("DECRYPTION_OR_CONTEXT");
    }
}
/** Exact, task-owned Keychain item only; no search of existing credentials. Creation is explicit and never automatic in a plan. */
export function recoveryBackupKeyFromKeychain(planSha256: string, allowCreate = false): Buffer {
    if (process.platform !== "darwin" || !/^[0-9a-f]{64}$/u.test(planSha256))
        return refused("KEYCHAIN_CONTEXT");
    const account = "codex-zmi-recovery", service = `com.yuge.codex.zmi-mirror-recovery.${planSha256}`;
    const read = () => spawnSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], { encoding: "utf8", timeout: 10000, maxBuffer: 16384 });
    let found = read();
    if (found.status === 44 && allowCreate) {
        const secret = randomBytes(32);
        // Interactive input keeps the password out of argv/process listings. No shell; all interpolated values are fixed or hex.
        const input = `add-generic-password -a ${account} -s ${service} -w ${secret.toString("hex")}\nquit\n`;
        const added = spawnSync("/usr/bin/security", ["-i"], { input, encoding: "utf8", timeout: 10000, maxBuffer: 16384 });
        if (added.error || added.status !== 0) {
            secret.fill(0);
            return refused("KEYCHAIN_CREATE");
        }
        found = read();
        const expected = sha(secret);
        secret.fill(0);
        if (found.error || found.status !== 0 || !/^[0-9a-f]{64}$/u.test(found.stdout.trim()) || sha(Buffer.from(found.stdout.trim(), "hex")) !== expected)
            return refused("KEYCHAIN_CREATE_READBACK");
    }
    if (found.error || found.status !== 0 || !/^[0-9a-f]{64}$/u.test(found.stdout.trim()))
        return refused("KEYCHAIN_READ");
    return Buffer.from(found.stdout.trim(), "hex");
}
