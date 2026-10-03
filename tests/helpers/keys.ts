import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface TestKeyPair {
  privateKeyPem: string;
  /** SEC1 ("BEGIN EC PRIVATE KEY") encoding of the same key, as produced by `openssl ecparam -genkey`. */
  privateKeySec1Pem: string;
  publicKey: KeyObject;
}

/** Generates a fresh EC P-256 key pair (the curve Apple requires for ES256). */
export function generateEs256KeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    privateKeySec1Pem: privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
    publicKey,
  };
}

export function generateRsaPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function generateP384PrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
