require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const PORT = Number(process.env.PORT || 3000);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';

if (!DEEPGRAM_API_KEY) {
    console.error('FATAL: DEEPGRAM_API_KEY is not set.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: FRONTEND_ORIGIN || true,
        methods: ['GET', 'POST']
    }
});

const deepgramClient = createClient(DEEPGRAM_API_KEY);

app.get('/', (_req, res) => {
    res.send('C-speech backend is running.');
});

app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
});

function looksLikeQuotaOrBillingError(err) {
    const text = JSON.stringify(err || {}).toLowerCase();
    return [
        'credit',
        'quota',
        'payment',
        'billing',
        'insufficient',
        '402',
        '429'
    ].some(token => text.includes(token));
}

function safeFinish(stream) {
    if (!stream) return;
    try { stream.finish(); } catch (_) {}
}

io.on('connection', (socket) => {
    console.log('[Socket.IO] Connected:', socket.id);

    let deepgramLive = null;
    let fallbackNotified = false;

    function closeDeepgram() {
        if (deepgramLive) {
            safeFinish(deepgramLive);
            deepgramLive = null;
        }
    }

    function notifyFallback(reason) {
        if (fallbackNotified) return;
        fallbackNotified = true;

        console.warn(`[Fallback] ${socket.id}: ${reason}`);
        closeDeepgram();
        socket.emit('deepgram-unavailable', { reason });
    }

    socket.on('start-stream', (payload = {}, ack = () => {}) => {
        closeDeepgram();
        fallbackNotified = false;

        const sampleRate = Number(payload.sampleRate) || 48000;

        console.log(`[Deepgram] Starting stream for ${socket.id} at ${sampleRate}Hz`);

        try {
            deepgramLive = deepgramClient.listen.live({
                model: 'nova-2',
                punctuate: true,
                interim_results: true,
                smart_format: true,
                encoding: 'linear16',
                sample_rate: sampleRate,
                channels: 1,
            });

            deepgramLive.on(LiveTranscriptionEvents.Open, () => {
                console.log('[Deepgram] Connection opened:', socket.id);
            });

            deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel?.alternatives?.[0]?.transcript;
                if (transcript) {
                    socket.emit('transcript', transcript);
                }
            });

            deepgramLive.on(LiveTranscriptionEvents.Close, () => {
                console.log('[Deepgram] Connection closed:', socket.id);
            });

            deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
                console.error('[Deepgram] Error:', err);

                const reason = looksLikeQuotaOrBillingError(err)
                    ? 'Deepgram credits exhausted or quota reached. Using browser speech recognition fallback.'
                    : 'Deepgram unavailable. Using browser speech recognition fallback.';

                notifyFallback(reason);
            });

            ack({ ok: true, provider: 'deepgram' });
        } catch (err) {
            console.error('[Deepgram] Failed to start stream:', err);

            const reason = looksLikeQuotaOrBillingError(err)
                ? 'Deepgram credits exhausted or quota reached. Using browser speech recognition fallback.'
                : 'Deepgram unavailable. Using browser speech recognition fallback.';

            notifyFallback(reason);
            ack({ ok: false, fallback: 'browser', reason });
        }
    });

    socket.on('audio-data', (data) => {
        if (
            deepgramLive &&
            typeof deepgramLive.getReadyState === 'function' &&
            deepgramLive.getReadyState() === 1
        ) {
            deepgramLive.send(data);
        }
    });

    socket.on('stop-stream', () => {
        closeDeepgram();
    });

    socket.on('disconnect', () => {
        console.log('[Socket.IO] Disconnected:', socket.id);
        closeDeepgram();
    });
});

server.listen(PORT, () => {
    console.log(`C-speech backend listening on port ${PORT}`);
});