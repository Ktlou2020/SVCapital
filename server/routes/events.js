/* ═══════════════════════════════════════════════════════════
   Admin SSE Stream — /api/events/stream
   Streams real-time admin notifications to connected clients.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');

const _clients = new Set();

/**
 * Broadcast an SSE event to all connected admin clients.
 * @param {string} type  SSE event name (e.g. 'kyc_submitted')
 * @param {object} data  JSON-serialisable payload
 */
function broadcast(type, data) {
  if (!_clients.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of _clients) {
    try { res.write(payload); } catch (_) { _clients.delete(res); }
  }
}

router.get('/stream', requireAuth, requireRole('admin', 'director'), (req, res) => {
  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 25000);

  _clients.add(res);

  res.on('close', () => {
    _clients.delete(res);
    clearInterval(heartbeat);
  });
});

module.exports = { router, broadcast };
