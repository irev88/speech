window.addEventListener('load', () => {
    const SOCKET_URL = (window.location.hostname === 'localhost')
        ? 'http://localhost:10000'
        : 'https://YOUR-RENDER-SERVICE.onrender.com'; // <-- replace after Render deploy

    const socket = io(SOCKET_URL, { transports: ['websocket'] });

    const statusDiv = document.getElementById('status');
    const transcriptionText = document.getElementById('transcription-text');
    const modeIndicator = document.getElementById('mode-indicator');
    const wordLimit = 8;

    let audioContext = null;
    let workletNode = null;
    let audioStream = null;

    // Fallback (Web Speech API)
    let fallbackRecognizer = null;
    let fallbackActive = false;

    function setMode(mode) {
        if (modeIndicator) modeIndicator.dataset.mode = mode;
    }

    function updateStatus(msg, keep = false) {
        statusDiv.textContent = msg;
        statusDiv.style.opacity = '1';
        if (!keep) {
            statusDiv.style.transition = 'opacity 1s ease-in-out 2s';
            setTimeout(() => { statusDiv.style.opacity = '0'; }, 50);
        }
    }

    socket.on('connect', () => {
        updateStatus('Click anywhere to start transcribing.', true);
        setMode('deepgram');
        document.body.addEventListener('click', startTranscription, { once: true });
    });

    socket.on('disconnect', () => {
        updateStatus('Connection lost. Please refresh.', true);
        setMode('error');
        stopTranscription();
        stopFallback();
    });

    socket.on('transcript', (transcript) => {
        const words = (transcript || '').split(' ').filter(Boolean);
        transcriptionText.textContent = words.slice(-wordLimit).join(' ');
    });

    socket.on('deepgram-status', (evt) => {
        if (evt.status === 'open') {
            updateStatus('Listening (Deepgram)...');
            setMode('deepgram');
        } else if (evt.status === 'closed') {
            updateStatus('Deepgram stream closed.');
            setMode('error');
        }
    });

    socket.on('deepgram-error', (evt) => {
        updateStatus('Deepgram error: ' + (evt.message || 'Unknown'), true);
        setMode('error');
        // Switch to fallback automatically
        enableFallback('Deepgram error — switching to local fallback.');
    });

    socket.on('fallback-notice', (evt) => {
        updateStatus('Fallback: ' + (evt.reason || 'Service unavailable'), true);
        enableFallback(evt.reason || 'Service unavailable.');
    });

    async function startTranscription() {
        try {
            updateStatus('Requesting microphone...');
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Prefer Deepgram streaming if socket is connected
            if (socket.connected) {
                await startDeepgramStreaming();
            } else {
                // Socket not connected — fallback immediately
                enableFallback('Not connected to backend.');
                return;
            }
        } catch (error) {
            console.error('Transcription setup failed:', error);
            enableFallback('Microphone permission denied or unavailable.');
        }
    }

    async function startDeepgramStreaming() {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000,
            });
            if (audioContext.state === 'suspended') await audioContext.resume();

            await audioContext.audioWorklet.addModule('audio-processor.js');

            socket.emit('start-stream');

            const source = audioContext.createMediaStreamSource(audioStream);
            workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

            workletNode.port.onmessage = (event) => {
                socket.emit('audio-data', event.data);
            };

            source.connect(workletNode);
            updateStatus('Listening (Deepgram)...');
            setMode('deepgram');
        } catch (err) {
            console.error('Deepgram streaming setup failed:', err);
            enableFallback('Could not start Deepgram streaming.');
        }
    }

    function enableFallback(reason) {
        stopTranscription(); // stop any Deepgram/audio pipeline
        if (fallbackActive) return;

        // Check Web Speech API availability
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            updateStatus('No fallback available in this browser.', true);
            setMode('error');
            return;
        }

        updateStatus(`Fallback: ${reason}`, true);
        setMode('fallback');

        fallbackRecognizer = new SpeechRecognition();
        fallbackRecognizer.continuous = true;
        fallbackRecognizer.interimResults = true;
        fallbackRecognizer.lang = 'en-US';

        fallbackRecognizer.onresult = (event) => {
            let finalText = '';
            let interimText = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const res = event.results[i];
                if (res.isFinal) finalText += res[0].transcript + ' ';
                else interimText += res[0].transcript;
            }

            const combined = (finalText + interimText).trim();
            const words = combined.split(' ').filter(Boolean);
            transcriptionText.textContent = words.slice(-wordLimit).join(' ');
        };

        fallbackRecognizer.onerror = (e) => {
            console.error('Fallback recognition error:', e);
            updateStatus('Fallback error: ' + (e.error || 'unknown'), true);
            setMode('error');
            stopFallback();
        };

        fallbackRecognizer.onend = () => {
            // Restart if user still wants it
            if (fallbackActive) {
                try { fallbackRecognizer.start(); } catch (_) {}
            }
        };

        try {
            fallbackRecognizer.start();
            fallbackActive = true;
        } catch (e) {
            console.error('Failed to start fallback recognizer:', e);
            updateStatus('Fallback failed to start.', true);
            setMode('error');
        }
    }

    function stopFallback() {
        if (fallbackRecognizer) {
            try { fallbackRecognizer.stop(); } catch (_) {}
            fallbackRecognizer = null;
        }
        fallbackActive = false;
    }

    function stopTranscription() {
        if (audioStream) audioStream.getTracks().forEach(t => t.stop());
        if (workletNode) workletNode.disconnect();
        if (audioContext) audioContext.close();
        audioStream = workletNode = audioContext = null;
    }
});