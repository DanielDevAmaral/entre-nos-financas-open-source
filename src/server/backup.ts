import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as derive,
} from "node:crypto";
const magic = Buffer.from("ENBACKUP1");
function key(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    derive(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}
export async function encryptBackup(
  data: Uint8Array,
  password: string,
): Promise<Buffer> {
  if (password.length < 16)
    throw new Error("Use uma senha de backup com pelo menos 16 caracteres.");
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await key(password, salt), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([magic, salt, iv, cipher.getAuthTag(), encrypted]);
}
export async function decryptBackup(
  data: Buffer,
  password: string,
): Promise<Buffer> {
  if (data.length < 53 || !data.subarray(0, 9).equals(magic))
    throw new Error("Formato de backup inválido.");
  const salt = data.subarray(9, 25),
    iv = data.subarray(25, 37),
    tag = data.subarray(37, 53);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await key(password, salt),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(53)), decipher.final()]);
}
