class PCMProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const channel = input[0];
        const int16 = new Int16Array(channel.length);

        for (let i = 0; i < channel.length; i++) {
            const s = Math.max(-1, Math.min(1, channel[i]));
            int16[i] = s < 0 ? s * 32768 : s * 32767;
        }

        this.port.postMessage(int16.buffer, [int16.buffer]);
        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);