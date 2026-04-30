import { generateKeyPairSync, createHash, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface NodeIdentity {
  nodeId: string;
  publicKeyHex: string;
  privateKeyHex: string;
}

export function loadOrCreateIdentity(identityDir: string): NodeIdentity {
  const idFile = join(identityDir, 'node.json');

  if (existsSync(idFile)) {
    return JSON.parse(readFileSync(idFile, 'utf-8')) as NodeIdentity;
  }

  mkdirSync(identityDir, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  const pubHex = (publicKey as unknown as Buffer).toString('hex');
  const identity: NodeIdentity = {
    nodeId: `node_${pubHex.slice(0, 16)}`,
    publicKeyHex: pubHex,
    privateKeyHex: (privateKey as unknown as Buffer).toString('hex'),
  };

  writeFileSync(idFile, JSON.stringify(identity, null, 2));
  console.log(`[identity] Created new node: ${identity.nodeId}`);
  return identity;
}

export function hashPayload(data: object): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function signPayload(data: object, privateKeyHex: string): string {
  const buf = Buffer.from(JSON.stringify(data));
  const privKey = { key: Buffer.from(privateKeyHex, 'hex'), format: 'der' as const, type: 'pkcs8' as const };
  return sign(null, buf, privKey).toString('hex');
}

export function verifySignature(data: object, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const buf = Buffer.from(JSON.stringify(data));
    const pubKey = { key: Buffer.from(publicKeyHex, 'hex'), format: 'der' as const, type: 'spki' as const };
    return verify(null, buf, pubKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
