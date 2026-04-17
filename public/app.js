window.addEventListener('load', () => {
    const config = window.C_SPEECH_CONFIG || {};
    const SOCKET_URL = config.SOCKET_URL;

    const statusDiv = document.getElementById('status');
    const transcriptionText = document.getElementById('transcription-text');
    const wordLimit = 8;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    let socket = null;
    let audioContext = null;
    let workletNode = null;
    let audioStream = null;
    let browserRecognition = null;
    let browserFallbackActive = false;
    let sessionStarted = false;

    function setStatus(message, visible = true) {
        statusDiv.textContent = message;
        statusDiv.style.opacity = visible ? '1' : '0';
    }

    function renderTranscript(transcript) {
        const words = String(transcript || '').trim().split(/\s+/).filter(Boolean);
        transcriptionText.textContent = words.slice(-wordLimit).join(' ');
    }

    function stopDeepgramCapture() {
        if (socket && socket.connected) {
            socket.emit('stop-stream');
        }

        if (audioStream) {
            audioStream.getTracks().forEach(track => track.stop());
            audioStream = null;
        }

        if (workletNode) {
            try { workletNode.disconnect(); } catch (_) {}
            workletNode = null;
        }

        if (audioContext) {
            try { audioContext.close(); } catch (_) {}
            audioContext = null;
        }
    }

    function stopBrowserFallback() {
        browserFallbackActive = false;

        if (browserRecognition) {
            const recognition = browserRecognition;
            browserRecognition = null;
            recognition.onend = null;
            try { recognition.stop(); } catch (_) {}
        }
    }

    function stopTranscription() {
        stopDeepgramCapture();
        stopBrowserFallback();
    }

    function emitWithAck(eventName, payload, timeoutMs = 8000) {
        if (!socket || !socket.connected) {
            return Promise.resolve({
                ok: false,
                fallback: 'browser',
                reason: 'Backend unavailable.'
            });
        }

        return new Promise((resolve) => {
            let finished = false;

            const timeout = setTimeout(() => {
                if (finished) return;
                finished = true;
                resolve({
                    ok: false,
                    fallback: 'browser',
                    reason: 'Backend timeout.'
                });
            }, timeoutMs);

            socket.emit(eventName, payload, (response) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                resolve(response || { ok: true });
            });
        });
    }

    function startBrowserFallback(reason) {
        if (browserFallbackActive) return;

        stopDeepgramCapture();

        if (!SpeechRecognition) {
            setStatus(
                `${reason || 'Transcription unavailable.'} Browser fallback is only supported in Chrome/Edge.`,
                true
            );
            return;
        }

        browserFallbackActive = true;
        browserRecognition = new SpeechRecognition();
        browserRecognition.continuous = true;
        browserRecognition.interimResults = true;
        browserRecognition.lang = 'en-US';

        browserRecognition.onstart = () => {
            setStatus(reason || 'Using browser speech recognition fallback.', true);
        };

        browserRecognition.onresult = (event) => {
            let fullTranscript = '';
            for (let i = 0; i < event.results.length; i++) {
                fullTranscript += event.results[i][0].transcript + ' ';
            }
            renderTranscript(fullTranscript);
            setStatus(reason || 'Using browser speech recognition fallback.', false);
        };

        browserRecognition.onerror = (event) => {
            console.error('Browser fallback error:', event);
            setStatus(`Fallback error: ${event.error}`, true);

            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                browserFallbackActive = false;
            }
        };

        browserRecognition.onend = () => {
            if (!browserFallbackActive) return;

            try {
                browserRecognition.start();
            } catch (_) {
                setTimeout(() => {
                    if (!browserFallbackActive) return;
                    try { browserRecognition.start(); } catch (err) {
                        console.error('Fallback restart failed:', err);
                    }
                }, 500);
            }
        };

        try {
            browserRecognition.start();
        } catch (error) {
            console.error('Could not start browser fallback:', error);
            setStatus(`Could not start browser fallback: ${error.message}`, true);
        }
    }

    async function startDeepgramCapture() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        await audioContext.audioWorklet.addModule('audio-processor.js');

        const response = await emitWithAck('start-stream', {
            sampleRate: audioContext.sampleRate
        });

        if (!response || response.ok === false) {
            stopDeepgramCapture();
            startBrowserFallback(response?.reason || 'Deepgram unavailable.');
            return;
        }

        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const source = audioContext.createMediaStreamSource(audioStream);
        workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

        workletNode.port.onmessage = (event) => {
            if (socket && socket.connected) {
                socket.emit('audio-data', event.data);
            }
        };

        source.connect(workletNode);
        setStatus('Listening...', false);
    }

    async function startTranscription() {
        if (sessionStarted) return;
        sessionStarted = true;

        try {
            setStatus('Starting...', true);

            if (socket && !socket.connected) {
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 4000);
                    socket.once('connect', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }

            if (!socket || !socket.connected) {
                return;
            }

            await startDeepgramCapture();
        } catch (error) {
            console.error('Transcription setup failed:', error);
            stopDeepgramCapture();
            startBrowserFallback('Deepgram setup failed. Using browser speech recognition fallback.');
        }
    }

    document.body.addEventListener('click', startTranscription, { once: true });

    if (!SOCKET_URL || SOCKET_URL.includes('YOUR-RENDER-SERVICE')) {
        setStatus('Configure public/config.js with your Render backend URL.', true);
        return;
    }

    socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        timeout: 2000,
    });

    socket.on('connect', () => {
        if (!sessionStarted) {
            setStatus('Click anywhere to start transcribing.', true);
        }
    });

    socket.on('connect_error', () => {
        if (!sessionStarted) {
            setStatus('Click anywhere to start transcribing. If the backend is asleep, browser fallback will be used.', true);
        }
    });

    socket.on('transcript', (transcript) => {
        renderTranscript(transcript);
    });

    socket.on('deepgram-unavailable', (payload) => {
        startBrowserFallback(
            payload?.reason || 'Deepgram credits exhausted or unavailable. Using browser speech recognition fallback.'
        );
    });

    socket.on('disconnect', () => {
        if (sessionStarted && !browserFallbackActive) {
            startBrowserFallback('Backend disconnected. Using browser speech recognition fallback.');
        }
    });

    window.addEventListener('beforeunload', stopTranscription);
});