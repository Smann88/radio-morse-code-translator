import { REVERSE_MORSE_MAP, getDotLength } from './morseEngine';

export class MorseMicReceiver {
  constructor(options = {}) {
    this.wpm = options.wpm || 20;
    this.pitch = options.pitch || 700; // Pitch of the beep to listen for
    this.threshold = options.threshold || 25; // dB above noise floor or absolute threshold
    
    // Callbacks
    this.onSignalChange = options.onSignalChange || null; // (isActive, currentDb)
    this.onSymbolDecoded = options.onSymbolDecoded || null; // ('.') or ('-')
    this.onCharacterDecoded = options.onCharacterDecoded || null; // ('A', '.-')
    this.onWordDecoded = options.onWordDecoded || null; // ('HELLO')
    this.onError = options.onError || null;

    this.deviceId = options.deviceId || null;
    this.isLoopback = options.isLoopback || false;

    // Web Audio State
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.loopbackInputNode = null;
    this.filterNode = null;
    this.analyserNode = null;
    
    // DSP State
    this.isListening = false;
    this.animationFrameId = null;
    
    // Decoding State Machine
    this.signalActive = false;
    this.lastStateChangeTime = 0;
    this.currentMorseChar = '';
    this.currentMorseWord = '';
    
    this.charTimeout = null;
    this.wordTimeout = null;
  }

  setWpm(wpm) {
    this.wpm = wpm;
  }

  setPitch(pitch) {
    this.pitch = pitch;
    if (this.filterNode && this.audioContext) {
      this.filterNode.frequency.setValueAtTime(pitch, this.audioContext.currentTime);
    }
  }

  setThreshold(threshold) {
    this.threshold = threshold;
  }

  async start() {
    if (this.isListening) return;
    
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // Resuming context if suspended (common browser policy)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Create Analyser for FFT power spectrum
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.2; // Fast response for dits/dahs

      if (this.isLoopback) {
        // Loopback mode: Create a gain node that players can connect to directly
        this.loopbackInputNode = this.audioContext.createGain();
        this.loopbackInputNode.connect(this.analyserNode);
      } else if (this.deviceId === 'system') {
        // System Audio Capture Mode
        this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: "browser", // Prefers tab share
            width: 320,
            height: 240,
            frameRate: 1
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
        const audioTracks = this.mediaStream.getAudioTracks();
        if (audioTracks.length === 0) {
          // If the user forgot to check the audio share, warn them
          this.mediaStream.getTracks().forEach(t => t.stop());
          throw new Error('No system audio track shared. Please check "Share system audio".');
        }
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.sourceNode.connect(this.analyserNode);
      } else {
        // Microphone Mode: Select the target device if specified
        const constraints = {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        };
        if (this.deviceId && this.deviceId !== 'default') {
          constraints.audio.deviceId = { exact: this.deviceId };
        }
        
        this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.sourceNode.connect(this.analyserNode);
      }

      this.isListening = true;
      this.lastStateChangeTime = Date.now();
      this.signalActive = false;
      this.currentMorseChar = '';
      this.currentMorseWord = '';
      
      // Start polling FFT data
      this.loop();
    } catch (err) {
      if (this.onError) this.onError(err);
      this.stop();
    }
  }

  stop() {
    this.isListening = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    clearTimeout(this.charTimeout);
    clearTimeout(this.wordTimeout);

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.sourceNode = null;
    this.loopbackInputNode = null;
    this.filterNode = null;
    this.analyserNode = null;
    this.signalActive = false;
  }

  loop = () => {
    if (!this.isListening || !this.analyserNode) return;
    
    this.animationFrameId = requestAnimationFrame(this.loop);
    
    const fftSize = this.analyserNode.fftSize;
    const sampleRate = this.audioContext.sampleRate;
    const bufferLength = this.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    this.analyserNode.getByteFrequencyData(dataArray);
    
    // Find FFT bin corresponding to our target pitch
    const targetBin = Math.round((this.pitch * fftSize) / sampleRate);
    
    // 1. Peak Amplitude (average of targetBin and its immediate neighbors for frequency drift)
    let peakSum = 0;
    let peakCount = 0;
    for (let i = targetBin - 1; i <= targetBin + 1; i++) {
      if (i >= 0 && i < bufferLength) {
        peakSum += dataArray[i];
        peakCount++;
      }
    }
    const peakAmplitude = peakCount > 0 ? peakSum / peakCount : 0;

    // 2. Local Noise Floor Amplitude (average of slightly further away bins)
    let noiseSum = 0;
    let noiseCount = 0;
    const noiseOffsets = [-8, -7, -6, -5, 5, 6, 7, 8];
    for (const offset of noiseOffsets) {
      const idx = targetBin + offset;
      if (idx >= 0 && idx < bufferLength) {
        noiseSum += dataArray[idx];
        noiseCount++;
      }
    }
    const noiseFloor = noiseCount > 0 ? noiseSum / noiseCount : 0;

    // 3. Prominence Index (signal strength above local noise floor)
    const diff = Math.max(0, peakAmplitude - noiseFloor);
    // Scale so that a 20dB prominence matches 100% signal strength
    const signalStrength = Math.min(100, (diff / 35) * 100);
    
    // Check signal state
    const isActiveNow = signalStrength > this.threshold;
    
    if (this.onSignalChange) {
      this.onSignalChange(isActiveNow, signalStrength);
    }
    
    this.processSignalState(isActiveNow);
  };

  processSignalState(isActiveNow) {
    const now = Date.now();
    const dotLen = getDotLength(this.wpm);
    
    if (isActiveNow !== this.signalActive) {
      // Signal Transition
      const duration = now - this.lastStateChangeTime;
      this.lastStateChangeTime = now;
      this.signalActive = isActiveNow;
      
      if (!isActiveNow) {
        // TONE ENDED (Signal goes from High -> Low)
        // A tone just finished. Decide if it was a dot or a dash.
        // Dot: 1 unit. Dash: 3 units.
        // Let's threshold at 1.8 * dotLength.
        if (duration > 15) { // Debounce extremely short glitches (< 15ms)
          const isDash = duration >= (dotLen * 1.8);
          const symbol = isDash ? '-' : '.';
          
          this.currentMorseChar += symbol;
          
          if (this.onSymbolDecoded) {
            this.onSymbolDecoded(symbol);
          }
          
          // Clear previous timeout and start character/word timers
          clearTimeout(this.charTimeout);
          clearTimeout(this.wordTimeout);
          
          // Character space is 3 units. Threshold at 2.5 * dotLength.
          this.charTimeout = setTimeout(() => {
            this.flushCharacter();
          }, dotLen * 2.5);
          
          // Word space is 7 units. Threshold at 5.5 * dotLength.
          this.wordTimeout = setTimeout(() => {
            this.flushWord();
          }, dotLen * 5.5);
        }
      } else {
        // TONE STARTED (Signal goes from Low -> High)
        // Silence has ended. We cancel character/word flush timers because the user is still keying.
        clearTimeout(this.charTimeout);
        clearTimeout(this.wordTimeout);
      }
    }
  }

  flushCharacter() {
    if (!this.currentMorseChar) return;
    
    const decodedChar = REVERSE_MORSE_MAP[this.currentMorseChar];
    if (decodedChar) {
      if (this.onCharacterDecoded) {
        this.onCharacterDecoded(decodedChar, this.currentMorseChar);
      }
      this.currentMorseWord += decodedChar;
    } else {
      // Invalid code
      if (this.onCharacterDecoded) {
        this.onCharacterDecoded('?', this.currentMorseChar);
      }
      this.currentMorseWord += '?';
    }
    this.currentMorseChar = '';
  }

  flushWord() {
    this.flushCharacter(); // Ensure last character in progress is flushed
    if (!this.currentMorseWord) return;
    
    if (this.onWordDecoded) {
      this.onWordDecoded(this.currentMorseWord);
    }
    this.currentMorseWord = '';
  }

  // Helper to extract frequency spectrum for visualization on canvas
  getSpectrumData() {
    if (!this.analyserNode) return null;
    const bufferLength = this.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyserNode.getByteFrequencyData(dataArray);
    return dataArray;
  }

  // Detects the loudest frequency peak in the 400Hz - 1000Hz range (CW band)
  detectPeakFrequency() {
    if (!this.analyserNode || !this.isListening) return null;
    const fftSize = this.analyserNode.fftSize;
    const sampleRate = this.audioContext.sampleRate;
    const bufferLength = this.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyserNode.getByteFrequencyData(dataArray);

    // Convert 400Hz and 1000Hz boundaries to FFT bin indexes
    const minBin = Math.round((400 * fftSize) / sampleRate);
    const maxBin = Math.round((1000 * fftSize) / sampleRate);

    let maxVal = 0;
    let peakBin = -1;

    for (let i = minBin; i <= maxBin; i++) {
      if (dataArray[i] > maxVal) {
        maxVal = dataArray[i];
        peakBin = i;
      }
    }

    // Calculate the average across the entire band to establish a local reference level
    let bandSum = 0;
    let bandCount = 0;
    for (let i = minBin; i <= maxBin; i++) {
      bandSum += dataArray[i];
      bandCount++;
    }
    const bandAverage = bandCount > 0 ? bandSum / bandCount : 0;

    // A real tone must stand out significantly (at least 30dB above the band average)
    const prominence = maxVal - bandAverage;

    if (maxVal > 60 && prominence > 30 && peakBin !== -1) {
      const detectedFrequency = Math.round((peakBin * sampleRate) / fftSize);
      return { frequency: detectedFrequency, amplitude: maxVal };
    }
    return null;
  }
}
