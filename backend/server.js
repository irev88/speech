require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const PORT = parseInt(process.env.PORT || '10000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('[WARN] DEEPGRAM_API_KEY not set. Backend will still run, but Deepgram streaming will be unavailable (frontend should use fallback).');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

const deepgramClient = process.env.DEEPGRAM_API_KEY
  ? createClient(process.env.DEEPGRAM_API_KEY)
  : null;

// Lightweight health endpoint
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    deepgramAvailable: !!deepgramClient,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Shutdown endpoint (optional but useful)
app.post('/shutdown', (req, res) => {
  console.log('[Server] Shutdown request received.');
  res.status(200).json({ message: 'Shutting down.' });
  io.close(() => console.log('[Socket.IO] Closed.'));
  server.close(() => {
    console.log('[HTTP] Closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
});

io.on('connection', (socket) => {
  console.log('[Socket.IO] Connected:', socket.id);
  let deepgramLive = null;

  socket.on('start-stream', () => {
    if (!deepgramClient) {
      console.warn('[Deepgram] Not configured — sending fallback-notice to client.');
      socket.emit('fallback-notice', {
        reason: 'Deepgram not configured on server.',
        useFallback: true,
      });
      return;
    }

    console.log('[Deepgram] Starting live stream for', socket.id);

    try {
      deepgramLive = deepgramClient.listen.live({
        model: 'nova-2',
        punctuate: true,
        interim_results: true,
        smart_format: true,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
      });

      deepgramLive.on(LiveTranscriptionEvents.Open, () => {
        console.log('[Deepgram] Opened:', socket.id);
        socket.emit('deepgram-status', { status: 'open' });
      });

      deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives[0]?.transcript;
        if (transcript) {
          socket.emit('transcript', transcript);
        }
      });

      deepgramLive.on(LiveTranscriptionEvents.Close, () => {
        console.log('[Deepgram] Closed:', socket.id);
        socket.emit('deepgram-status', { status: 'closed' });
      });

      deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('[Deepgram] Error for', socket.id, err);
        socket.emit('deepgram-error', { message: err?.message || 'Deepgram error' });
      });
    } catch (err) {
      console.error('[Deepgram] Failed to create live stream:', err);
      socket.emit('fallback-notice', {
        reason: 'Failed to start Deepgram stream.',
        useFallback: true,
      });
    }
  });

  socket.on('audio-data', (data) => {
    if (deepgramLive && deepgramLive.getReadyState() === 1) {
      deepgramLive.send(data);
    } else if (!deepgramLive) {
      // If Deepgram never started, client should fallback
      socket.emit('fallback-notice', {
        reason: 'Deepgram stream not active.',
        useFallback: true,
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket.IO] Disconnected:', socket.id);
    if (deepgramLive) {
      try { deepgramLive.finish(); } catch (_) {}
      deepgramLive = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  console.log(`[Server] Deepgram available: ${!!deepgramClient}`);
  console.log(`[Server] CORS origin: ${CORS_ORIGIN}`);
});