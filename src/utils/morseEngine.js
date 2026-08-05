// Morse Code Dictionary
export const MORSE_MAP = {
  'A': '.-',     'B': '-...',   'C': '-.-.',   'D': '-..',    'E': '.',
  'F': '..-.',   'G': '--.',    'H': '....',   'I': '..',     'J': '.---',
  'K': '-.-',    'L': '.-..',   'M': '--',     'N': '-.',     'O': '---',
  'P': '.--.',   'Q': '--.-',   'R': '.-.',    'S': '...',    'T': '-',
  'U': '..-',    'V': '...-',   'W': '.--',    'X': '-..-',   'Y': '-.--',
  'Z': '--..',
  '1': '.----',  '2': '..---',  '3': '...--',  '4': '....-',  '5': '.....',
  '6': '-....',  '7': '--...',  '8': '---..',  '9': '----.',  '0': '-----',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--',
  '/': '-..-.',  '(': '-.--.',  ')': '-.--.-', '&': '.-...',   ':': '---...',
  ';': '-.-.-.', '=': '-...-',  '+': '.-.-.',  '-': '-....-', '_': '..--.-',
  '"': '.-..-.', '$': '...-..-', '@': '.--.-.', ' ': ' '
};

// Reverse lookup dictionary for decoding
export const REVERSE_MORSE_MAP = Object.entries(MORSE_MAP).reduce((acc, [char, morse]) => {
  if (char !== ' ') {
    acc[morse] = char;
  }
  return acc;
}, {});

/**
 * Translates alphanumeric English text to Morse Code.
 * Words are separated by a slash " / ". Letters are separated by spaces.
 */
export function textToMorse(text) {
  if (!text) return '';
  return text
    .toUpperCase()
    .trim()
    .split(/\s+/) // split by spaces into words
    .map(word => 
      word
        .split('')
        .map(char => MORSE_MAP[char] || '')
        .filter(morse => morse !== '')
        .join(' ')
    )
    .join(' / ');
}

/**
 * Translates Morse Code to alphanumeric English text.
 * Expects words separated by " / " or "   " (3 spaces), and letters by spaces.
 */
export function morseToText(morse) {
  if (!morse) return '';
  // Normalize word separators
  const normalized = morse.trim().replace(/\s+\/\s+/g, '   ');
  return normalized
    .split('   ') // Split into words
    .map(word => 
      word
        .split(' ') // Split into letters
        .map(code => REVERSE_MORSE_MAP[code] || '?')
        .join('')
    )
    .join(' ');
}

/**
 * Calculates dot duration in milliseconds based on Words Per Minute (WPM).
 * WPM formula: Dot length = 1200 / WPM (standard PARIS system)
 */
export function getDotLength(wpm) {
  const safeWpm = Math.max(1, Math.min(100, wpm));
  return 1200 / safeWpm;
}

/**
 * Class to decode manual spacebar tap intervals into Morse code characters
 * Adaptive timing or fixed timing based on standard dot lengths.
 */
export class ManualTapKeyer {
  constructor(wpm, onCharacterDecoded, onWordDecoded) {
    this.wpm = wpm;
    this.dotLength = getDotLength(wpm);
    this.onCharacterDecoded = onCharacterDecoded;
    this.onWordDecoded = onWordDecoded;
    
    this.lastActionTime = 0;
    this.isKeyDown = false;
    this.currentMorseWord = '';
    this.currentMorseChar = '';
    
    this.wordTimeout = null;
    this.charTimeout = null;
  }

  setWpm(wpm) {
    this.wpm = wpm;
    this.dotLength = getDotLength(wpm);
  }

  // When key is pressed down
  keyDown() {
    if (this.isKeyDown) return;
    this.isKeyDown = true;
    const now = Date.now();
    
    // Clear completion timeouts
    clearTimeout(this.charTimeout);
    clearTimeout(this.wordTimeout);
    
    this.lastActionTime = now;
  }

  // When key is released
  keyUp() {
    if (!this.isKeyDown) return;
    this.isKeyDown = false;
    const now = Date.now();
    const downDuration = now - this.lastActionTime;
    
    // Determine dit vs dah
    // Dot is 1 unit, Dash is 3 units. Threshold at 1.8 units.
    const dotThreshold = this.dotLength * 1.8;
    const signal = downDuration < dotThreshold ? '.' : '-';
    
    this.currentMorseChar += signal;
    this.lastActionTime = now;
    
    // Start timers for character and word spacing
    // Character space is 3 dots. Threshold at 2.5 dots.
    this.charTimeout = setTimeout(() => {
      this.flushCharacter();
    }, this.dotLength * 2.5);
    
    // Word space is 7 dots. Threshold at 5.5 dots.
    this.wordTimeout = setTimeout(() => {
      this.flushWord();
    }, this.dotLength * 5.5);

    return signal; // Returns '.' or '-'
  }

  flushCharacter() {
    if (!this.currentMorseChar) return;
    const decodedChar = REVERSE_MORSE_MAP[this.currentMorseChar] || '?';
    if (this.onCharacterDecoded) {
      this.onCharacterDecoded(decodedChar, this.currentMorseChar);
    }
    this.currentMorseWord += decodedChar;
    this.currentMorseChar = '';
  }

  flushWord() {
    this.flushCharacter(); // Ensure last char is flushed
    if (!this.currentMorseWord) return;
    if (this.onWordDecoded) {
      this.onWordDecoded(this.currentMorseWord);
    }
    this.currentMorseWord = '';
  }

  reset() {
    clearTimeout(this.charTimeout);
    clearTimeout(this.wordTimeout);
    this.currentMorseChar = '';
    this.currentMorseWord = '';
    this.isKeyDown = false;
    this.lastActionTime = 0;
  }
}

/**
 * Class to play Morse Code audio using the Web Audio API with smooth envelopes.
 */
export class MorsePlayer {
  constructor(audioContext = null) {
    this.audioContext = audioContext;
    this.oscillator = null;
    this.gainNode = null;
    this.pitch = 700; // Hz
    this.wpm = 20;
    this.volume = 0.5;
    
    this.activeOscillator = null;
    this.activeGainNode = null;
    this.activeTimeouts = [];
    this.loopbackDestinationNode = null;
    this.dualPitch = false;
  }
  
  initAudio() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  // Plays a single beep manually (for the manual straight key)
  startBeep() {
    this.initAudio();
    this.stopBeep();

    const ctx = this.audioContext;
    this.oscillator = ctx.createOscillator();
    this.gainNode = ctx.createGain();

    this.oscillator.type = 'sine';
    this.oscillator.frequency.value = this.pitch;

    // Smooth envelope ramp-up (5ms)
    this.gainNode.gain.setValueAtTime(0, ctx.currentTime);
    this.gainNode.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 0.005);

    this.oscillator.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);
    if (this.loopbackDestinationNode) {
      this.gainNode.connect(this.loopbackDestinationNode);
    }

    this.oscillator.start();
  }

  stopBeep() {
    if (this.oscillator && this.gainNode && this.audioContext) {
      const ctx = this.audioContext;
      try {
        const currentGain = this.gainNode.gain.value;
        this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
        this.gainNode.gain.setValueAtTime(currentGain, ctx.currentTime);
        // Smooth decay (8ms)
        this.gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.008);
        
        const oscToStop = this.oscillator;
        setTimeout(() => {
          try { oscToStop.stop(); oscToStop.disconnect(); } catch(e){}
        }, 20);
      } catch (e) {
        try { this.oscillator.stop(); } catch(err) {}
      }
      this.oscillator = null;
      this.gainNode = null;
    }
  }

  // Plays a full Morse sentence scheduled precisely in the future
  playMorseSequence(morseStr, onCharActive = null, onFinished = null) {
    this.initAudio();
    this.stopAll();

    const ctx = this.audioContext;
    const dotLen = getDotLength(this.wpm) / 1000; // convert to seconds
    let currentTime = ctx.currentTime + 0.05; // slight pre-delay

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = this.pitch;
    
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    if (this.loopbackDestinationNode) {
      gainNode.connect(this.loopbackDestinationNode);
    }
    osc.start();

    this.activeOscillator = osc;
    this.activeGainNode = gainNode;

    const tokens = morseStr.split('');

    for (let i = 0; i < tokens.length; i++) {
      const char = tokens[i];
      if (char === '.') {
        // Play dot (High-pitch if dual-pitch is enabled)
        const tonePitch = this.dualPitch ? this.pitch + 80 : this.pitch;
        osc.frequency.setValueAtTime(tonePitch, currentTime);
        
        gainNode.gain.setValueAtTime(0, currentTime);
        gainNode.gain.linearRampToValueAtTime(this.volume, currentTime + 0.005);
        gainNode.gain.setValueAtTime(this.volume, currentTime + dotLen - 0.005);
        gainNode.gain.linearRampToValueAtTime(0, currentTime + dotLen);
        currentTime += dotLen;
      } else if (char === '-') {
        // Play dash (3 dots, Low-pitch if dual-pitch is enabled)
        const tonePitch = this.dualPitch ? this.pitch - 80 : this.pitch;
        osc.frequency.setValueAtTime(tonePitch, currentTime);
        
        const dashLen = dotLen * 3;
        gainNode.gain.setValueAtTime(0, currentTime);
        gainNode.gain.linearRampToValueAtTime(this.volume, currentTime + 0.005);
        gainNode.gain.setValueAtTime(this.volume, currentTime + dashLen - 0.005);
        gainNode.gain.linearRampToValueAtTime(0, currentTime + dashLen);
        currentTime += dashLen;
      } else if (char === ' ') {
        const nextChar = tokens[i + 1];
        if (nextChar === '/') {
          currentTime += dotLen * 4; // Word break: total 7 dots
        } else {
          currentTime += dotLen * 2; // Letter break: total 3 dots
        }
      } else if (char === '/') {
        currentTime += dotLen * 2;
      }
      
      // Standard spacing after dot or dash
      if (char === '.' || char === '-') {
        currentTime += dotLen;
      }

      // Track active character trigger
      if (onCharActive && (char === '.' || char === '-' || char === ' ' || char === '/')) {
        const triggerTime = (currentTime - ctx.currentTime) * 1000;
        const timeoutId = setTimeout(() => {
          onCharActive(i);
        }, triggerTime);
        this.activeTimeouts.push(timeoutId);
      }
    }

    // Stop oscillator at the end
    const totalTime = currentTime - ctx.currentTime;
    const endTimeoutId = setTimeout(() => {
      this.stopAll();
      if (onFinished) onFinished();
    }, totalTime * 1000 + 50);
    this.activeTimeouts.push(endTimeoutId);
  }

  stopAll() {
    this.activeTimeouts.forEach(clearTimeout);
    this.activeTimeouts = [];
    if (this.activeOscillator) {
      try { this.activeOscillator.stop(); this.activeOscillator.disconnect(); } catch(e){}
      this.activeOscillator = null;
    }
    if (this.activeGainNode) {
      try { this.activeGainNode.disconnect(); } catch(e){}
      this.activeGainNode = null;
    }
    this.stopBeep();
  }
}
