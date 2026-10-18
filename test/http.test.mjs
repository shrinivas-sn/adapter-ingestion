import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBodyBytes, decodeJson } from '../src/http.mjs';

function chunkedResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream);
}

test('readBodyBytes returns the exact bytes of a 3-chunk body', async () => {
  const { buffer, bytes } = await readBodyBytes(chunkedResponse(['ab', 'cd', 'é']));
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(bytes, 6);
  assert.deepEqual(buffer, Buffer.from('abcdé', 'utf8'));
});

test('readBodyBytes throws E_RESPONSE_LIMIT one byte past max_response_bytes', async () => {
  await assert.rejects(
    readBodyBytes(chunkedResponse(['abc', 'de']), { maxResponseBytes: 4 }),
    { code: 'E_RESPONSE_LIMIT' },
  );
  const { bytes } = await readBodyBytes(chunkedResponse(['abc', 'd']), { maxResponseBytes: 4 });
  assert.equal(bytes, 4);
});

test('readBodyBytes treats a missing body stream as empty', async () => {
  const { buffer, bytes } = await readBodyBytes({ body: null });
  assert.equal(bytes, 0);
  assert.equal(buffer.length, 0);
});

test('decodeJson: an empty buffer is null', () => {
  assert.equal(decodeJson(Buffer.alloc(0)), null);
});

test('decodeJson: invalid JSON is E_RESPONSE_JSON with the existing message', () => {
  assert.throws(() => decodeJson(Buffer.from('{')), {
    code: 'E_RESPONSE_JSON',
    message: 'response body is not valid JSON',
  });
});
