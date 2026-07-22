import { createHash } from 'crypto';

/** Collision-safe, reversible encoding of one semantic embedding identity. */
export const embeddingSemanticIdentity = (nodeId: string, chunkIndex: number): string =>
  JSON.stringify([nodeId, chunkIndex]);

/** Stable, order-independent digest of semantic `(nodeId, chunkIndex)` keys. */
export const embeddingIdentitySetDigest = (identities: ReadonlySet<string>): string => {
  const digest = createHash('sha256');
  digest.update('gitnexus.embedding-identities/v1\0');
  for (const identity of [...identities].sort()) {
    const encoded = Buffer.from(identity, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    digest.update(length);
    digest.update(encoded);
  }
  return digest.digest('hex');
};
