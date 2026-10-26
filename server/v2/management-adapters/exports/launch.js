import { spawn } from 'node:child_process';

// Own the process before connecting: Puppeteer's launch() rejection can precede its async cleanup.
export async function launchOwnedChromium(options, observeProcess) {
  const puppeteer = (await import('puppeteer-core')).default;
  options.signal?.throwIfAborted();
  const args = await puppeteer.defaultArgs({ ...options, args: [...options.args, '--remote-debugging-pipe'] });
  options.signal?.throwIfAborted();
  const child = spawn(options.executablePath, args, {
    env: options.env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  observeProcess(child, exited);
  await spawned;
  options.signal?.throwIfAborted();
  const transport = createPipeTransport(child.stdio[3], child.stdio[4], options.maxTransportBytes);
  const browser = await puppeteer.connect({ transport, protocolTimeout: Math.min(options.timeout, options.protocolTimeout),
    defaultViewport: options.defaultViewport });
  return browser;
}

/** NUL-delimited CDP over owned stdio; bound incoming frames before decoding base64/JSON. */
function createPipeTransport(write, read, maxBytes) {
  let closed = false, parts = [], length = 0;
  const transport = {
    onmessage: undefined, onclose: undefined,
    send(message) { if (closed) throw new Error('Export transport closed'); write.write(message + '\0'); },
    close() {
      if (closed) return;
      closed = true; parts = []; length = 0;
      read.removeListener('data', data); read.removeListener('close', ended);
      read.destroy(); write.destroy();
    }
  };
  function ended() { if (closed) return; transport.close(); transport.onclose?.(); }
  function data(chunk) {
    if (closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(0, offset), finish = end < 0 ? chunk.length : end;
      const part = chunk.subarray(offset, finish);
      length += part.length;
      if (length > maxBytes) { ended(); return; }
      parts.push(part);
      if (end >= 0) {
        const message = Buffer.concat(parts, length).toString('utf8');
        parts = []; length = 0; transport.onmessage?.(message);
      }
      offset = end < 0 ? chunk.length : end + 1;
    }
  }
  read.on('data', data); read.once('close', ended); read.on('error', ended); write.on('error', ended);
  return transport;
}
