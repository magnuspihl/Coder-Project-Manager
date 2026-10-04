import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { decodeHeaderText } from './auth.js';

/** Send a raw request whose X-Client-Name header carries exactly `valueBytes`,
 * and return what a real Node HTTP server decodes it to. */
async function clientNameAsReceived(valueBytes: Buffer): Promise<string> {
  let seen = '';
  const server = http.createServer((req, res) => {
    seen = decodeHeaderText(String(req.headers['x-client-name']));
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(Buffer.concat([
          Buffer.from('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Client-Name: '),
          valueBytes,
          Buffer.from('\r\n\r\n'),
        ]));
      });
      sock.on('data', () => {});
      sock.on('end', resolve);
      sock.on('error', reject);
    });
  } finally {
    server.close();
  }
  return seen;
}

test('a client name sent as UTF-8 bytes ("Mímir") is shown as Mímir', async () => {
  assert.equal(await clientNameAsReceived(Buffer.from('Mímir', 'utf8')), 'Mímir');
});

test('a client name sent as Latin-1 bytes, as fetch does, is shown as Mímir rather than M�mir', async () => {
  assert.equal(await clientNameAsReceived(Buffer.from('Mímir', 'latin1')), 'Mímir');
});

test('a plain ASCII client name is passed through unchanged', async () => {
  assert.equal(await clientNameAsReceived(Buffer.from('OpenClaw')), 'OpenClaw');
});
