/**
 * Nansen CLI - Mock WebSocket server for local daemon testing.
 *
 * Usage:
 *   node src/daemon/mock-server.js [--port 9876] [--interval 10]
 *
 * Fires a fake alert every --interval seconds. Useful for developing
 * and testing the daemon without a real Nansen WS backend.
 */

import { WebSocketServer } from 'ws';
import http from 'http';

const port = parseInt(process.argv.find((a, i, arr) => arr[i - 1] === '--port') ?? '9876');
const intervalSec = parseInt(process.argv.find((a, i, arr) => arr[i - 1] === '--interval') ?? '10');

const MOCK_ALERTS = [
  {
    type: 'alert',
    alertId: 'mock-001',
    alertName: 'ETH SM Inflow >5M',
    alertType: 'sm-token-flows',
    firedAt: null, // filled at fire time
    data: {
      chain: 'ethereum',
      token: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH' },
      inflow_1h: 6_200_000,
      netflow_1h: 4_100_000,
    },
  },
  {
    type: 'alert',
    alertId: 'mock-002',
    alertName: 'Large USDC Transfer',
    alertType: 'common-token-transfer',
    firedAt: null,
    data: {
      chain: 'ethereum',
      event: 'send',
      usdValue: 2_500_000,
      from: '0xabc...1234',
      to: '0xdef...5678',
      token: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
    },
  },
];

// Simple HTTP server to handle /api/v1/smart-alert/past-alerts
const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/v1/smart-alert/past-alerts')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      alerts: [],
      count: 0,
      oldest: null,
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer, path: '/v1/smart-alert/stream' });

wss.on('connection', (ws, req) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Missing API key' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  const sessionId = `mock-sess-${Date.now()}`;
  console.log(`[mock-server] Client connected, session=${sessionId}`);

  ws.send(JSON.stringify({
    type: 'connected',
    sessionId,
    serverTime: new Date().toISOString(),
  }));

  // Handle pings
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      }
    } catch { /* ignore unparseable client messages */ }
  });

  // Fire mock alerts on interval
  let alertIndex = 0;
  const interval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(interval);
      return;
    }
    const template = MOCK_ALERTS[alertIndex % MOCK_ALERTS.length];
    const alert = { ...template, firedAt: new Date().toISOString() };
    console.log(`[mock-server] Firing alert: ${alert.alertId} — ${alert.alertName}`);
    ws.send(JSON.stringify(alert));
    alertIndex++;
  }, intervalSec * 1000);

  ws.on('close', () => {
    clearInterval(interval);
    console.log(`[mock-server] Client disconnected, session=${sessionId}`);
  });
});

httpServer.listen(port, () => {
  console.log(`[mock-server] Listening on ws://localhost:${port}/v1/smart-alert/stream`);
  console.log(`[mock-server] Firing alerts every ${intervalSec}s`);
  console.log(`[mock-server] REST: http://localhost:${port}/api/v1/smart-alert/past-alerts`);
});
