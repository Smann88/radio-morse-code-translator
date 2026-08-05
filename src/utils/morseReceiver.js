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
    this.onPitchChange = options.onPitchChange || null; // (newPitchHz)
    this.onError = options.onError || null;

    this.deviceId = options.deviceId || null;
    this.isLoopback = options.isLoopback || false;
    
    this.basePitch = options.pitch || 700;
    this.dualPitchMode = options.dualPitchMode || false;
    this.activeTonePitch = options.pitch || 700;

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

  setBasePitch(basePitch) {
    this.basePitch = basePitch;
    this.pitch = basePitch;
  }

  setDualPitchMode(enabled) {
    this.dualPitchMode = enabled;
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
      this.analyserNode.fftSize = 1024;
      this.analyserNode.smoothingTimeConstant = 0.0; // Instantaneous temporal response

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
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false }
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
      this.basePitch = this.pitch;
      this.activeTonePitch = this.pitch;
      
      // Start high-frequency polling interval (250Hz sampling rate)
      this.timerId = setInterval(this.loop, 4);
    } catch (err) {
      if (this.onError) this.onError(err);
      this.stop();
    }
  }

  stop() {
    this.isListening = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
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
    
    const fftSize = this.analyserNode.fftSize;
    const sampleRate = this.audioContext.sampleRate;
    const bufferLength = this.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    this.analyserNode.getByteFrequencyData(dataArray);
    
    // Define boundaries of the CW Morse frequency range (400Hz - 1000Hz)
    const minBin = Math.round((400 * fftSize) / sampleRate);
    const maxBin = Math.round((1000 * fftSize) / sampleRate);
    
    // Find the strongest peak frequency bin in the CW range
    let peakAmplitude = 0;
    let peakBin = -1;
    let sumAmplitude = 0;
    let countBins = 0;
    
    for (let i = minBin; i <= maxBin; i++) {
      if (i >= 0 && i < bufferLength) {
        sumAmplitude += dataArray[i];
        countBins++;
        if (dataArray[i] > peakAmplitude) {
          peakAmplitude = dataArray[i];
          peakBin = i;
        }
      }
    }
    
    // Average amplitude of the entire band (used as dynamic noise floor)
    const averageBandAmplitude = countBins > 0 ? sumAmplitude / countBins : 0;
    
    // If we found a peak, measure its prominence above the band average noise floor
    let prominence = 0;
    let peakFreq = this.pitch; // default to current VFO pitch
    
    if (peakBin !== -1) {
      peakFreq = Math.round((peakBin * sampleRate) / fftSize);
      prominence = Math.max(0, peakAmplitude - averageBandAmplitude);
    }
    
    // Convert prominence to a 0-100% signal strength
    // A 30dB prominence stands out clearly and represents 100% signal strength
    const signalStrength = Math.min(100, (prominence / 30) * 100);
    
    // Decide if a Morse beep is active in the range
    // If the signal strength is above threshold and peakAmplitude is prominent enough (>50)
    const isActiveNow = (signalStrength > this.threshold) && (peakAmplitude > 55);
    
    if (this.onSignalChange) {
      this.onSignalChange(isActiveNow, signalStrength);
    }
    
    // Auto-update the receiver's pitch if there is an active prominent beep in the band
    if (isActiveNow && peakFreq >= 400 && peakFreq <= 1000) {
      this.activeTonePitch = peakFreq;
      
      // If NOT in dual-pitch mode, let the VFO auto-tune to follow the frequency
      if (!this.dualPitchMode && peakFreq !== this.pitch) {
        this.pitch = peakFreq;
        if (this.onPitchChange) {
          this.onPitchChange(peakFreq);
        }
      }
    }
    
    // --- DEBOUNCE SCHMITT TRIGGER HYSTERESIS ---
    const now = Date.now();
    if (this.rawSignalState === undefined) {
      this.rawSignalState = false;
      this.rawStateChangeTime = now;
    }

    if (isActiveNow !== this.rawSignalState) {
      this.rawSignalState = isActiveNow;
      this.rawStateChangeTime = now;
    }

    // Commits state transition only if it has persisted for at least 8ms (filters room glitch/clicks)
    const debounceDelay = 8;
    if (this.rawSignalState !== this.signalActive && (now - this.rawStateChangeTime >= debounceDelay)) {
      const duration = now - this.lastStateChangeTime - debounceDelay;
      this.lastStateChangeTime = now - debounceDelay;
      
      const wasActive = this.signalActive;
      this.signalActive = this.rawSignalState;
      
      this.processSignalTransition(wasActive, duration);
    }
  };

  processSignalTransition(wasActive, duration) {
    const dotLen = getDotLength(this.wpm);
    
    if (wasActive) {
      // TONE ENDED (Signal goes from High -> Low)
      // Compensate for Web Audio analyser FFT windowing latency (inherent ~21ms window size)
      const adjustedDuration = duration - 12; 
      
      // Check for dual-pitch Morse classification
      // If the tone pitch is at least 35Hz above the baseline, it is classified as a dit (.)
      // If it's at least 35Hz below the baseline, it is classified as a dah (-)
      let symbol = '';
      const pitchDiff = this.activeTonePitch - this.basePitch;
      
      if (this.dualPitchMode && Math.abs(pitchDiff) >= 35) {
        symbol = pitchDiff > 0 ? '.' : '-';
        console.log(`📻 [DSP DECODER] Dual-Pitch Classification! Tone Freq: ${this.activeTonePitch}Hz (Base VFO: ${this.basePitch}Hz, Diff: ${pitchDiff}Hz) -> Decoded: "${symbol}"`);
      } else {
        // Standard Fallback: Midpoint of 2.2 * dotLen is optimal for separating dits and dashes
        const isDash = adjustedDuration >= (dotLen * 2.2);
        symbol = isDash ? '-' : '.';
      }
      
      console.log(`📻 [DSP DECODER] Tone Ended. Raw: ${duration}ms, Adjusted: ${adjustedDuration}ms, Midpoint Threshold: ${Math.round(dotLen * 2.2)}ms (DotLen: ${Math.round(dotLen)}ms, WPM: ${this.wpm}, ToneFreq: ${this.activeTonePitch}Hz). Decoded Symbol: "${symbol}"`);
      
      if (adjustedDuration > 15) { // Ensure minimum symbol length
        this.currentMorseChar += symbol;
        
        if (this.onSymbolDecoded) {
          this.onSymbolDecoded(symbol);
        }
        
        // Clear previous timeouts and set spacing flushes
        clearTimeout(this.charTimeout);
        clearTimeout(this.wordTimeout);
        
        // Spacing: Letter space is 3 units (threshold at 3.5), Word space is 7 units (threshold at 6.5)
        this.charTimeout = setTimeout(() => {
          this.flushCharacter();
        }, dotLen * 3.5);
        
        this.wordTimeout = setTimeout(() => {
          this.flushWord();
        }, dotLen * 6.5);
      }
    } else {
      // TONE STARTED (Signal goes from Low -> High)
      // Silence ended: cancel pending character/word flushes
      clearTimeout(this.charTimeout);
      clearTimeout(this.wordTimeout);
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
