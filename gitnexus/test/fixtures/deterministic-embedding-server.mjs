import crypto from 'node:crypto';
import http from 'node:http';

const dimensions = 384;
const model = 'gitnexus-test-deterministic-v1';

const deterministicVector = (text) => {
  const digest = crypto.createHash('sha256').update(text).digest();
  const vector = Array.from(
    { length: dimensions },
    (_, index) => digest[index % digest.length] / 127.5 - 1,
  );
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
};

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (!inputs.every((input) => typeof input === 'string')) {
        throw new Error('input must be a string or string array');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          model,
          data: inputs.map((input, index) => ({
            object: 'embedding',
            index,
            embedding: deterministicVector(input),
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      );
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('embedding server has no TCP address');
process.stdout.write(`EMBEDDING_SERVER=http://127.0.0.1:${address.port}/v1\n`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
