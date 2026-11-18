import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8797);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const server = createServer((request, response) => {
  const isHealth = request.method === 'GET' && request.url === '/health';
  response.writeHead(isHealth ? 200 : 404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(isHealth ? { ok: true, mode: 'local' } : { error: 'not_found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Development service at http://127.0.0.1:${port}/health`);
});
