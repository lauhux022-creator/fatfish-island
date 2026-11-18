import { createServer } from 'node:http';
import { ROOM_SNAPSHOT_HZ } from '../shared/net/types';
import { attachRoomServer } from './rooms';

const port = Number(process.env.PORT ?? 8797);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const host = process.env.ROOM_HOST?.trim() || '127.0.0.1';
const origins = process.env.ROOM_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean);
const server = createServer((request, response) => {
  const isHealth = request.method === 'GET' && request.url === '/health';
  response.writeHead(isHealth ? 200 : 404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(isHealth ? { ok: true, mode: 'rooms', snapshotHz: ROOM_SNAPSHOT_HZ } : { error: 'not_found' }));
});
const rooms = attachRoomServer(server, { origins });

function shutdown() {
  rooms.close();
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.listen(port, host, () => {
  const address = host.includes(':') ? `[${host}]` : host;
  console.log(`Room service at http://${address}:${port}/health`);
});
