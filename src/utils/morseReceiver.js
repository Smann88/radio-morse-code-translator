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

    // Web Audio State
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
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
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // Resuming context if suspended (common browser policy)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Create an aggressive narrow Bandpass Filter
      // Center frequency is the target beep pitch
      // Q is Quality factor. Higher Q = narrower bandwidth. Q = 25 is excellent for isolating a beep.
      this.filterNode = this.audioContext.createBiquadFilter();
      this.filterNode.type = 'bandpass';
      this.filterNode.frequency.setValueAtTime(this.pitch, this.audioContext.currentTime);
      this.filterNode.Q.setValueAtTime(25, this.audioContext.currentTime);

      // Create Analyser for FFT power spectrum
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.4; // Slightly smooth out transient spikes

      // Connect graph: Mic -> Filter -> Analyser
      this.sourceNode.connect(this.filterNode);
      this.filterNode.connect(this.analyserNode);

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
    // binIndex = pitch * fftSize / sampleRate
    const targetBin = Math.round((this.pitch * fftSize) / sampleRate);
    
    // Get amplitude around the target frequency (averaging nearby bins to account for slight frequency drift)
    let sum = 0;
    const binWindow = 2; // Check 2 bins on either side of targetBin
    let count = 0;
    
    for (let i = targetBin - binWindow; i <= targetBin + binWindow; i++) {
      if (i >= 0 && i < bufferLength) {
        sum += dataArray[i];
        count++;
      }
    }
    
    const targetAmplitude = count > 0 ? sum / count : 0;
    
    // Convert 0-255 amplitude to a relative strength index (0 to 100)
    const signalStrength = (targetAmplitude / 255) * 100;
    
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
}
