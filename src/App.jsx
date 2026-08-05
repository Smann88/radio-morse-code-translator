import React, { useState, useEffect, useRef } from 'react';
import { 
  Radio, 
  Send, 
  Volume2, 
  Sparkles, 
  HelpCircle, 
  RotateCcw, 
  Mic, 
  MicOff, 
  Play, 
  Square, 
  Flame, 
  FileText, 
  Key, 
  Activity,
  Sliders,
  AlertCircle
} from 'lucide-react';
import { 
  textToMorse, 
  morseToText, 
  MorsePlayer, 
  ManualTapKeyer,
  MORSE_MAP
} from './utils/morseEngine';
import { MorseMicReceiver } from './utils/morseReceiver';

function App() {
  // General Radio State
  const [activeTab, setActiveTab] = useState('transmitter'); // 'transmitter', 'receiver', 'keyer'
  const [frequency, setFrequency] = useState(7030.0); // 7.030 MHz is standard QRP CW freq
  const [wpm, setWpm] = useState(20);
  const [pitch, setPitch] = useState(700); // Hz
  const [volume, setVolume] = useState(0.4);
  const [showCheatSheet, setShowCheatSheet] = useState(true);
  
  // Audio Context Ref (Shared between Player and Receiver)
  const audioCtxRef = useRef(null);

  // --- TRANSMITTER STATE ---
  const [inputText, setInputText] = useState('CQ CQ DE SMANN88 K');
  const [morseOutput, setMorseOutput] = useState('');
  const [isPlayingSequence, setIsPlayingSequence] = useState(false);
  const [activeTokenIndex, setActiveTokenIndex] = useState(-1);
  const [isTxActive, setIsTxActive] = useState(false); // For visual indicator during automated Tx
  
  // --- RECEIVER STATE ---
  const [isRxActive, setIsRxActive] = useState(false);
  const [rxThreshold, setRxThreshold] = useState(25); // Sensitivity dB/Strength
  const [rxDecodedText, setRxDecodedText] = useState('');
  const [rxCurrentMorseBuffer, setRxCurrentMorseBuffer] = useState('');
  const [rxSignalStrength, setRxSignalStrength] = useState(0);
  const [isRxSignalActive, setIsRxSignalActive] = useState(false);
  const [rxError, setRxError] = useState(null);
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('default'); // 'default', 'loopback', or actual device ID

  // --- MANUAL KEYER STATE ---
  const [keyerDecodedText, setKeyerDecodedText] = useState('');
  const [keyerCurrentMorse, setKeyerCurrentMorse] = useState('');
  const [isKeyerDown, setIsKeyerDown] = useState(false);
  const [keyerStats, setKeyerStats] = useState({ pressDur: 0, gapDur: 0 });

  // Engine Refs
  const morsePlayerRef = useRef(null);
  const morseReceiverRef = useRef(null);
  const manualKeyerRef = useRef(null);
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  
  // Timing ref for manual key stats
  const keyDownTimeRef = useRef(0);
  const keyUpTimeRef = useRef(0);

  // Enumerate all available physical audio inputs
  const fetchAudioDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      setAudioDevices(audioInputs);
    } catch (err) {
      console.warn('Error enumerating audio devices:', err);
    }
  };

  // Initialize Engines on Mount
  useEffect(() => {
    fetchAudioDevices();

    // Instantiate Player
    morsePlayerRef.current = new MorsePlayer();
    morsePlayerRef.current.pitch = pitch;
    morsePlayerRef.current.wpm = wpm;
    morsePlayerRef.current.volume = volume;

    // Instantiate Manual Keyer
    manualKeyerRef.current = new ManualTapKeyer(
      wpm,
      (char, morse) => {
        setKeyerDecodedText(prev => prev + char);
        setKeyerCurrentMorse('');
      },
      (word) => {
        setKeyerDecodedText(prev => prev + ' ');
      }
    );

    // Initial Translation
    setMorseOutput(textToMorse(inputText));

    return () => {
      if (morsePlayerRef.current) morsePlayerRef.current.stopAll();
      if (morseReceiverRef.current) morseReceiverRef.current.stop();
      if (manualKeyerRef.current) manualKeyerRef.current.reset();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  // Update Player Parameters on State Changes
  useEffect(() => {
    if (morsePlayerRef.current) {
      morsePlayerRef.current.pitch = pitch;
      morsePlayerRef.current.wpm = wpm;
      morsePlayerRef.current.volume = volume;
    }
  }, [pitch, wpm, volume]);

  // Update Manual Keyer Parameters
  useEffect(() => {
    if (manualKeyerRef.current) {
      manualKeyerRef.current.setWpm(wpm);
    }
  }, [wpm]);

  // Sync Input Text with Morse Output
  useEffect(() => {
    setMorseOutput(textToMorse(inputText));
  }, [inputText]);

  // Handle Tuning / Frequency adjustment
  const handleTune = (amount) => {
    // Adjust frequency by +/- 0.1 or 1.0 kHz
    const newFreq = Math.max(7000.0, Math.min(7300.0, frequency + amount));
    setFrequency(Math.round(newFreq * 100) / 100);
    
    // Changing frequency slightly alters pitch (authentic radio heterodyne vibe!)
    const pitchShift = Math.max(400, Math.min(1000, pitch + Math.round(amount * 100)));
    setPitch(pitchShift);
  };

  // --- AUTOMATED TRANSMISSION (TEXT -> MORSE AUDIO) ---
  const handleTransmit = () => {
    if (!morsePlayerRef.current) return;
    if (isPlayingSequence) {
      handleStopTransmission();
      return;
    }

    setIsPlayingSequence(true);
    setActiveTokenIndex(0);

    // Sync parameters before play
    morsePlayerRef.current.pitch = pitch;
    morsePlayerRef.current.wpm = wpm;
    morsePlayerRef.current.volume = volume;

    morsePlayerRef.current.playMorseSequence(
      morseOutput,
      (tokenIdx) => {
        setActiveTokenIndex(tokenIdx);
        // Toggle physical TX light based on character types (dits or dahs light up)
        const char = morseOutput[tokenIdx];
        if (char === '.' || char === '-') {
          setIsTxActive(true);
          // Auto turn off soon after
          setTimeout(() => setIsTxActive(false), char === '.' ? 60 : 180);
        } else {
          setIsTxActive(false);
        }
      },
      () => {
        setIsPlayingSequence(false);
        setActiveTokenIndex(-1);
        setIsTxActive(false);
      }
    );
  };

  const handleStopTransmission = () => {
    if (morsePlayerRef.current) {
      morsePlayerRef.current.stopAll();
    }
    setIsPlayingSequence(false);
    setActiveTokenIndex(-1);
    setIsTxActive(false);
  };

  // --- DSP MICROPHONE RECEIVER ---
  const toggleReceiver = async () => {
    if (isRxActive) {
      // Stop Receiver
      if (morseReceiverRef.current) {
        morseReceiverRef.current.stop();
      }
      setIsRxActive(false);
      setIsRxSignalActive(false);
      setRxSignalStrength(0);
      if (morsePlayerRef.current) {
        morsePlayerRef.current.loopbackDestinationNode = null;
      }
    } else {
      // Start Receiver
      setRxError(null);
      // Instantiate Receiver inside the toggle to ensure modern browsers allow mic context
      morseReceiverRef.current = new MorseMicReceiver({
        wpm: wpm,
        pitch: pitch,
        threshold: rxThreshold,
        deviceId: selectedDeviceId !== 'default' && selectedDeviceId !== 'loopback' ? selectedDeviceId : null,
        isLoopback: selectedDeviceId === 'loopback',
        onSignalChange: (isActive, level) => {
          setIsRxSignalActive(isActive);
          setRxSignalStrength(Math.min(100, Math.round(level)));
        },
        onSymbolDecoded: (symbol) => {
          setRxCurrentMorseBuffer(prev => prev + symbol);
        },
        onCharacterDecoded: (char, rawMorse) => {
          setRxDecodedText(prev => prev + char);
          setRxCurrentMorseBuffer('');
        },
        onWordDecoded: (word) => {
          setRxDecodedText(prev => prev + ' ');
        },
        onError: (err) => {
          console.error(err);
          setRxError('Microphone Access Denied or Blocked. Please check browser settings.');
          setIsRxActive(false);
        }
      });

      await morseReceiverRef.current.start();
      setIsRxActive(true);

      // Re-fetch devices to update actual labels now that mic permission is given
      fetchAudioDevices();

      // Hook up loopback routing if selected
      if (selectedDeviceId === 'loopback' && morseReceiverRef.current && morsePlayerRef.current) {
        morsePlayerRef.current.audioContext = morseReceiverRef.current.audioContext;
        morsePlayerRef.current.loopbackDestinationNode = morseReceiverRef.current.loopbackInputNode;
      } else if (morsePlayerRef.current) {
        morsePlayerRef.current.loopbackDestinationNode = null;
      }
    }
  };

  // Hot-swap receiver device on source selection change
  useEffect(() => {
    if (isRxActive) {
      const restart = async () => {
        if (morseReceiverRef.current) {
          morseReceiverRef.current.stop();
        }
        setIsRxActive(false);
        setIsRxSignalActive(false);
        setRxSignalStrength(0);
        setTimeout(() => {
          toggleReceiver();
        }, 150);
      };
      restart();
    }
  }, [selectedDeviceId]);

  // Sync Threshold & Settings with Active Receiver
  useEffect(() => {
    if (morseReceiverRef.current) {
      morseReceiverRef.current.setThreshold(rxThreshold);
    }
  }, [rxThreshold]);

  useEffect(() => {
    if (morseReceiverRef.current) {
      morseReceiverRef.current.setPitch(pitch);
      morseReceiverRef.current.setWpm(wpm);
    }
  }, [pitch, wpm]);

  // --- MANUAL KEYER PRACTICE (CW KEY) ---
  const handleKeyStart = (e) => {
    if (e) e.preventDefault();
    if (isKeyerDown) return;
    
    setIsKeyerDown(true);
    setIsTxActive(true);

    // Synthesize beep
    if (morsePlayerRef.current) {
      morsePlayerRef.current.pitch = pitch;
      morsePlayerRef.current.volume = volume;
      morsePlayerRef.current.startBeep();
    }

    // Capture timing stats
    const now = Date.now();
    keyDownTimeRef.current = now;
    let upDuration = 0;
    if (keyUpTimeRef.current > 0) {
      upDuration = now - keyUpTimeRef.current;
    }

    // Keyer Engine timing
    if (manualKeyerRef.current) {
      manualKeyerRef.current.keyDown();
    }

    setKeyerStats(prev => ({
      ...prev,
      gapDur: upDuration
    }));
  };

  const handleKeyEnd = (e) => {
    if (e) e.preventDefault();
    if (!isKeyerDown) return;
    
    setIsKeyerDown(false);
    setIsTxActive(false);

    if (morsePlayerRef.current) {
      morsePlayerRef.current.stopBeep();
    }

    // Capture timing stats
    const now = Date.now();
    keyUpTimeRef.current = now;
    const downDuration = now - keyDownTimeRef.current;

    // Keyer Engine decode
    if (manualKeyerRef.current) {
      const symbol = manualKeyerRef.current.keyUp();
      if (symbol) {
        setKeyerCurrentMorse(prev => prev + symbol);
      }
    }

    setKeyerStats(prev => ({
      ...prev,
      pressDur: downDuration
    }));
  };

  // Listen to Spacebar for Manual Keyer
  useEffect(() => {
    const handleKeyDownGlobal = (e) => {
      if (activeTab !== 'keyer') return;
      // Exclude input fields from space trigger
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        handleKeyStart();
      }
    };

    const handleKeyUpGlobal = (e) => {
      if (activeTab !== 'keyer') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleKeyEnd();
      }
    };

    window.addEventListener('keydown', handleKeyDownGlobal);
    window.addEventListener('keyup', handleKeyUpGlobal);

    return () => {
      window.removeEventListener('keydown', handleKeyDownGlobal);
      window.removeEventListener('keyup', handleKeyUpGlobal);
    };
  }, [activeTab, isKeyerDown, pitch, volume]);

  // Clean Manual Keyer Text
  const resetKeyerText = () => {
    if (manualKeyerRef.current) {
      manualKeyerRef.current.reset();
    }
    setKeyerDecodedText('');
    setKeyerCurrentMorse('');
    setKeyerStats({ pressDur: 0, gapDur: 0 });
  };

  // Clean Receiver Text
  const resetReceiverText = () => {
    setRxDecodedText('');
    setRxCurrentMorseBuffer('');
  };

  // --- AUDIO VISUALIZER CANVAS DRAW ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      
      const width = canvas.width;
      const height = canvas.height;
      ctx.fillStyle = '#09090b'; // zinc-950
      ctx.fillRect(0, 0, width, height);

      // Draw GRID lines (radar/CRT effect)
      ctx.strokeStyle = 'rgba(22, 163, 74, 0.15)'; // emerald-600
      ctx.lineWidth = 1;
      
      // Horizontal grid
      for (let y = 15; y < height; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      // Vertical grid
      for (let x = 30; x < width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      // Live Microphone Spectrum Data
      if (isRxActive && morseReceiverRef.current) {
        const spectrum = morseReceiverRef.current.getSpectrumData();
        if (spectrum) {
          ctx.strokeStyle = '#22c55e'; // emerald-500
          ctx.lineWidth = 2.5;
          ctx.shadowBlur = 10;
          ctx.shadowColor = '#22c55e';
          
          ctx.beginPath();
          const sliceWidth = width / (spectrum.length / 2); // view lower frequency band where Morse tone lies
          let x = 0;
          
          for (let i = 0; i < spectrum.length / 2; i++) {
            const v = spectrum[i] / 255.0;
            const y = height - (v * height * 0.95) - 2;
            
            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }
            x += sliceWidth;
          }
          ctx.lineTo(width, height);
          ctx.stroke();
          
          // Reset shadow
          ctx.shadowBlur = 0;
          
          // Draw a small target marker at the frequency bin corresponding to active tuning pitch
          const sampleRate = morseReceiverRef.current.audioContext.sampleRate;
          const fftSize = morseReceiverRef.current.analyserNode.fftSize;
          const targetBin = Math.round((pitch * fftSize) / sampleRate);
          const targetX = (targetBin / (spectrum.length / 2)) * width;
          
          ctx.fillStyle = '#ef4444'; // red-500 indicator
          ctx.beginPath();
          ctx.arc(targetX, height - 10, 4, 0, 2 * Math.PI);
          ctx.fill();
          
          ctx.fillStyle = '#ef4444';
          ctx.font = '9px monospace';
          ctx.fillText(`Target: ${pitch}Hz`, targetX - 35, height - 18);
        }
      } 
      // Else Simulated Waveform if Transmitter or Manual CW Key is Active
      else {
        ctx.strokeStyle = isTxActive ? '#f97316' : '#22c55e'; // orange or emerald
        ctx.shadowBlur = isTxActive ? 8 : 2;
        ctx.shadowColor = isTxActive ? '#f97316' : '#22c55e';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        let x = 0;
        const amplitude = isTxActive ? (height * 0.35) : 1.5; // bounce slightly if silent
        const frequencyMultiplier = isTxActive ? (pitch / 400) * 0.15 : 0.03;
        
        for (let i = 0; i < width; i++) {
          const y = (height / 2) + Math.sin(i * frequencyMultiplier + Date.now() * 0.015) * amplitude;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(i, y);
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    };
    
    draw();
    return () => {
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isRxActive, isTxActive, pitch]);

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-start p-4 md:p-8 select-none">
      {/* Header Transceiver branding */}
      <div className="w-full max-w-5xl mb-6 flex flex-col md:flex-row items-center justify-between border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-zinc-900 border border-emerald-600 rounded-md shadow-[0_0_8px_rgba(16,185,129,0.2)]">
            <Radio className="w-6 h-6 text-emerald-500 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-widest text-zinc-100 uppercase font-mono">
              SM-88 CW TRANSCEIVER
            </h1>
            <p className="text-xs text-zinc-500 font-mono">RADIO MORSE TRANSLATOR & DECODER DSP v1.2</p>
          </div>
        </div>

        {/* LED Indicators */}
        <div className="flex items-center gap-6 mt-4 md:mt-0 bg-zinc-900 px-4 py-2 border border-zinc-800 rounded font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-full border ${isRxActive ? 'bg-emerald-500 border-emerald-400 shadow-[0_0_8px_#10b981]' : 'bg-zinc-800 border-zinc-700'}`}></span>
            <span className="text-zinc-400">RX MODE</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-full border ${isTxActive ? 'bg-orange-500 border-orange-400 shadow-[0_0_8px_#f97316]' : 'bg-zinc-800 border-zinc-700'}`}></span>
            <span className="text-zinc-400">TX ACTIVE</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-full border ${isRxSignalActive ? 'bg-green-400 border-green-300 shadow-[0_0_8px_#4ade80]' : 'bg-zinc-800 border-zinc-700'}`}></span>
            <span className="text-zinc-400">SIGNAL DETECTED</span>
          </div>
        </div>
      </div>

      {/* Main Grid Interface */}
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* LEFT COLUMN - MAIN ANALOG RADIO READOUT AND DIALS (5 COLS) */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          
          {/* Main Glowing Frequency Window */}
          <div className="bg-zinc-900 border-2 border-zinc-800 rounded-lg p-5 flex flex-col justify-between relative overflow-hidden shadow-inner">
            <div className="absolute inset-0 scanlines opacity-30 pointer-events-none"></div>
            
            <div className="flex justify-between items-center text-zinc-500 font-mono text-[10px] mb-2 z-10">
              <span>FREQUENCY DIAL</span>
              <span className="text-emerald-500 uppercase flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                VFO A
              </span>
            </div>

            {/* Freq LED digit display */}
            <div className="flex items-baseline justify-center gap-1 font-mono font-bold tracking-wider py-2 z-10">
              <span className="text-emerald-400 text-4xl font-extrabold drop-shadow-[0_0_6px_rgba(52,211,153,0.6)]">
                {Math.floor(frequency / 1000).toString().padStart(2, '0')}
              </span>
              <span className="text-emerald-400 text-4xl drop-shadow-[0_0_6px_rgba(52,211,153,0.6)]">.</span>
              <span className="text-emerald-400 text-4xl font-extrabold drop-shadow-[0_0_6px_rgba(52,211,153,0.6)]">
                {Math.floor(frequency % 1000).toString().padStart(3, '0')}
              </span>
              <span className="text-emerald-400 text-lg">.</span>
              <span className="text-emerald-500 text-lg font-medium">00</span>
              <span className="text-emerald-600 text-base ml-2">MHz</span>
            </div>

            {/* Tuning Controls */}
            <div className="grid grid-cols-4 gap-1.5 mt-4 z-10 font-mono text-xs">
              <button onClick={() => handleTune(-1.0)} className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-300 py-1 border border-zinc-700 rounded transition font-bold">
                -1k
              </button>
              <button onClick={() => handleTune(-0.1)} className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-300 py-1 border border-zinc-700 rounded transition font-bold">
                -0.1k
              </button>
              <button onClick={() => handleTune(0.1)} className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-300 py-1 border border-zinc-700 rounded transition font-bold">
                +0.1k
              </button>
              <button onClick={() => handleTune(1.0)} className="bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-300 py-1 border border-zinc-700 rounded transition font-bold">
                +1k
              </button>
            </div>
          </div>

          {/* S-Meter and Controls Dashboard */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex flex-col gap-5">
            {/* Analog style S-Meter */}
            <div className="font-mono text-[10px]">
              <div className="flex justify-between text-zinc-500 mb-1">
                <span>SIGNAL STRENGTH (S-METER)</span>
                <span className={isRxSignalActive ? 'text-emerald-400' : 'text-zinc-600'}>
                  {isRxActive ? `FFT ${rxSignalStrength}%` : 'INTERNAL CW'}
                </span>
              </div>
              {/* Meter bar */}
              <div className="h-2.5 w-full bg-zinc-950 border border-zinc-800 rounded-sm flex overflow-hidden">
                {Array.from({ length: 20 }).map((_, i) => {
                  const val = (i + 1) * 5;
                  const isActive = isRxActive ? (rxSignalStrength >= val) : (isTxActive && val <= 75);
                  let bgClass = 'bg-zinc-900';
                  if (isActive) {
                    if (val < 60) bgClass = 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.5)]';
                    else if (val < 85) bgClass = 'bg-yellow-500 shadow-[0_0_4px_rgba(234,179,8,0.5)]';
                    else bgClass = 'bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.5)]';
                  }
                  return <div key={i} className={`flex-1 h-full border-r border-zinc-950 last:border-0 ${bgClass}`} />;
                })}
              </div>
              <div className="flex justify-between text-zinc-600 text-[8px] mt-1 font-mono">
                <span>S1</span>
                <span>S3</span>
                <span>S5</span>
                <span>S7</span>
                <span>S9</span>
                <span className="text-red-600">+10dB</span>
                <span className="text-red-600">+20dB</span>
              </div>
            </div>

            {/* Speed & Pitch Control sliders */}
            <div className="flex flex-col gap-4 font-mono">
              {/* Speed WPM */}
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span className="flex items-center gap-1">
                    <Sliders className="w-3.5 h-3.5 text-zinc-500" /> SPEED (WPM)
                  </span>
                  <span className="text-zinc-200 font-bold">{wpm} WPM</span>
                </div>
                <input 
                  type="range" 
                  min="5" 
                  max="40" 
                  value={wpm} 
                  onChange={(e) => setWpm(parseInt(e.target.value))}
                  className="w-full accent-emerald-500 h-1 bg-zinc-850 rounded"
                />
              </div>

              {/* Pitch Frequency */}
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span className="flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 text-zinc-500" /> BEEP PITCH (Hz)
                  </span>
                  <span className="text-zinc-200 font-bold">{pitch} Hz</span>
                </div>
                <input 
                  type="range" 
                  min="400" 
                  max="1000" 
                  value={pitch} 
                  step="10"
                  onChange={(e) => setPitch(parseInt(e.target.value))}
                  className="w-full accent-emerald-500 h-1 bg-zinc-850 rounded"
                />
              </div>

              {/* Volume */}
              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span className="flex items-center gap-1">
                    <Volume2 className="w-3.5 h-3.5 text-zinc-500" /> VOLUME
                  </span>
                  <span className="text-zinc-200 font-bold">{Math.round(volume * 100)}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="1" 
                  step="0.05"
                  value={volume} 
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-full accent-emerald-500 h-1 bg-zinc-850 rounded"
                />
              </div>
            </div>
          </div>

          {/* CRT Oscilloscope Screen */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex flex-col relative">
            <div className="text-[10px] font-mono text-zinc-500 mb-1">
              SIGNAL DECODING OSCILLOSCOPE
            </div>
            <div className="border border-zinc-950 rounded-sm overflow-hidden bg-zinc-950 h-32 relative">
              <canvas 
                ref={canvasRef} 
                width="360" 
                height="128" 
                className="w-full h-full block"
              />
              <div className="absolute top-2 right-2 text-[8px] font-mono text-emerald-500 bg-zinc-950/70 px-1 border border-emerald-950">
                SWEEP RATE: AUTO
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN - THREE OPERATIONAL TABS (7 COLS) */}
        <div className="lg:col-span-7 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          
          {/* Tab Selection */}
          <div className="flex border-b border-zinc-800 bg-zinc-900/50 font-mono text-xs font-semibold">
            <button 
              onClick={() => setActiveTab('transmitter')}
              className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 border-r border-zinc-800 transition ${activeTab === 'transmitter' ? 'bg-zinc-900 text-orange-400 border-t-2 border-t-orange-500' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'}`}
            >
              <Send className="w-4 h-4" />
              TRANSMITTER
            </button>
            <button 
              onClick={() => setActiveTab('receiver')}
              className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 border-r border-zinc-800 transition ${activeTab === 'receiver' ? 'bg-zinc-900 text-emerald-400 border-t-2 border-t-emerald-500' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'}`}
            >
              <Mic className="w-4 h-4" />
              DSP RECEIVER
            </button>
            <button 
              onClick={() => setActiveTab('keyer')}
              className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 transition ${activeTab === 'keyer' ? 'bg-zinc-900 text-yellow-400 border-t-2 border-t-yellow-500' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'}`}
            >
              <Key className="w-4 h-4" />
              PRACTICE KEY
            </button>
          </div>

          {/* Tab Content Panel */}
          <div className="p-6 flex-1 flex flex-col justify-between">
            
            {/* TAB A: AUTOMATIC TRANSMITTER */}
            {activeTab === 'transmitter' && (
              <div className="flex-1 flex flex-col gap-4">
                <div className="flex items-center gap-2 text-orange-400 text-xs font-mono">
                  <Sparkles className="w-4 h-4" />
                  <span>TRANSLATE TEXT TO MORSE BEETS & SOUND WAVE</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-zinc-400 font-mono text-xs">Text to Transmit</label>
                  <textarea
                    rows="3"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value.toUpperCase())}
                    placeholder="ENTER ALPHANUMERIC MESSAGE..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-orange-500 resize-none uppercase"
                    disabled={isPlayingSequence}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-zinc-400 font-mono text-xs">Translated Morse Code</label>
                  <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-sm min-h-[4.5rem] break-all max-h-36 overflow-y-auto leading-relaxed select-text">
                    {morseOutput.split('').map((char, index) => {
                      const isActive = isPlayingSequence && activeTokenIndex === index;
                      return (
                        <span 
                          key={index} 
                          className={`inline-block transition-colors duration-75 px-0.5 rounded ${isActive ? 'bg-orange-500 text-zinc-950 font-bold scale-110 shadow-[0_0_6px_#f97316]' : 'text-zinc-400'}`}
                        >
                          {char}
                        </span>
                      );
                    })}
                    {!morseOutput && <span className="text-zinc-800">NO CHARACTER TO DECODE</span>}
                  </div>
                </div>

                {/* Transmit Buttons */}
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={handleTransmit}
                    className={`flex-1 py-3 px-6 rounded font-mono font-bold text-sm transition flex items-center justify-center gap-2 shadow ${isPlayingSequence ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-orange-500 hover:bg-orange-400 text-zinc-950'}`}
                  >
                    {isPlayingSequence ? (
                      <>
                        <Square className="w-4 h-4" />
                        ABORT TRANSMISSION
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4" />
                        AUTOMATED TRANSMIT
                      </>
                    )}
                  </button>
                  <button 
                    onClick={() => setInputText('')}
                    disabled={isPlayingSequence}
                    className="p-3 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-300 rounded border border-zinc-700 transition"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* TAB B: DSP DECODER RECEIVER */}
            {activeTab === 'receiver' && (
              <div className="flex-1 flex flex-col gap-4">
                <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono">
                  <Flame className="w-4 h-4 animate-bounce" />
                  <span>DSP REAL-TIME AUDIO MORSE CODE DECODER</span>
                </div>

                {rxError && (
                  <div className="bg-red-950/40 border border-red-800/60 p-3 rounded text-red-400 font-mono text-xs flex gap-2 items-start">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{rxError}</span>
                  </div>
                )}

                {/* Audio Input Source Dropdown */}
                <div className="flex flex-col gap-1.5 font-mono">
                  <label className="text-zinc-400 text-xs">Audio Input Source</label>
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded p-2.5 text-xs text-zinc-300 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="default">🎙️ System Default Microphone</option>
                    <option value="loopback">🔌 Internal Virtual Loopback (No Microphone Needed)</option>
                    {audioDevices.map((device, index) => (
                      <option key={device.deviceId || index} value={device.deviceId}>
                        🎙️ {device.label || `Microphone ${index + 1} (${device.deviceId.slice(0, 5)}...)`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Mic listening switch */}
                <div className="flex items-center justify-between bg-zinc-950 p-4 border border-zinc-800 rounded">
                  <div className="font-mono">
                    <div className="text-xs text-zinc-300 font-bold flex items-center gap-1">
                      {isRxActive ? <Mic className="w-3.5 h-3.5 text-emerald-400 animate-pulse" /> : <MicOff className="w-3.5 h-3.5 text-zinc-500" />}
                      RECEIVE STATE
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {isRxActive 
                        ? (selectedDeviceId === 'loopback' ? 'Listening to internal loopback...' : 'Listening to microphone...') 
                        : 'Receiver inactive'}
                    </div>
                  </div>
                  <button
                    onClick={toggleReceiver}
                    className={`py-2 px-5 rounded font-mono font-bold text-xs border transition ${isRxActive ? 'bg-red-950/40 border-red-500 text-red-400 hover:bg-red-900/40' : 'bg-emerald-500 border-emerald-400 text-zinc-950 hover:bg-emerald-400 shadow'}`}
                  >
                    {isRxActive ? 'DISCONNECT' : 'CONNECT DECODER'}
                  </button>
                </div>

                {/* RX Threshold tuning slider */}
                <div className="flex flex-col gap-1 bg-zinc-950/40 border border-zinc-800/40 p-3 rounded font-mono">
                  <div className="flex justify-between text-xs text-zinc-400">
                    <span className="flex items-center gap-1 text-zinc-400">
                      THRESHOLD (DECODER FILTER SENSITIVITY)
                    </span>
                    <span className="text-zinc-300 font-bold">{rxThreshold}</span>
                  </div>
                  <input 
                    type="range" 
                    min="10" 
                    max="60" 
                    value={rxThreshold} 
                    onChange={(e) => setRxThreshold(parseInt(e.target.value))}
                    className="w-full accent-emerald-500 h-1 bg-zinc-850 rounded cursor-pointer"
                  />
                  <div className="flex justify-between text-[8px] text-zinc-600 mt-0.5">
                    <span>LOW (NOISE)</span>
                    <span>MID</span>
                    <span>HIGH (ONLY CLEAR BEEP)</span>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {/* Current decoding buffer */}
                  <div className="col-span-1 flex flex-col gap-1">
                    <span className="text-zinc-400 font-mono text-[10px]">CURRENT SYMBOL</span>
                    <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-2.5 font-mono text-center text-lg font-extrabold text-emerald-400 min-h-[2.5rem] tracking-wider">
                      {rxCurrentMorseBuffer || <span className="text-zinc-800 text-xs">-</span>}
                    </div>
                  </div>
                  {/* Visual LED status */}
                  <div className="col-span-2 flex flex-col gap-1">
                    <span className="text-zinc-400 font-mono text-[10px]">RX SIGNAL DEMODULATOR</span>
                    <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-2.5 flex items-center justify-center gap-2 font-mono text-xs min-h-[2.5rem]">
                      <span className={`w-3.5 h-3.5 rounded-full ${isRxSignalActive ? 'bg-emerald-400 animate-ping' : 'bg-zinc-800'}`}></span>
                      <span className={isRxSignalActive ? 'text-emerald-400 font-bold' : 'text-zinc-600'}>
                        {isRxSignalActive ? 'TONE DETECTED' : 'STATIC / NO TONE'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Decoded Output text */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-zinc-400 font-mono text-xs">Decoded Audio Text</label>
                    <button 
                      onClick={resetReceiverText}
                      className="text-[10px] text-zinc-500 hover:text-zinc-300 transition underline font-mono"
                    >
                      CLEAR
                    </button>
                  </div>
                  <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-sm min-h-[4.5rem] break-all max-h-36 overflow-y-auto uppercase leading-relaxed text-zinc-100 select-text">
                    {rxDecodedText || <span className="text-zinc-800">WAITING FOR MORSE CODE AUDIO BEETS...</span>}
                  </div>
                </div>
              </div>
            )}

            {/* TAB C: PRACTICE STRAIGHT KEYER */}
            {activeTab === 'keyer' && (
              <div className="flex-1 flex flex-col gap-4">
                <div className="flex items-center justify-between text-yellow-500 text-xs font-mono">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-yellow-500" />
                    <span>MANUAL PRACTICE KEYER (CW KEY)</span>
                  </div>
                  <span className="text-[10px] text-zinc-500">TIP: PRESS SPACEBAR TO TAP</span>
                </div>

                <div className="grid grid-cols-2 gap-3 font-mono text-xs">
                  {/* Current tapped buffer */}
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-500 text-[10px]">MORSE INPUT</span>
                    <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-yellow-400 text-center font-bold text-sm tracking-widest min-h-[2rem]">
                      {keyerCurrentMorse || <span className="text-zinc-800">-</span>}
                    </div>
                  </div>
                  {/* Stats */}
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-500 text-[10px]">TAP DURATION</span>
                    <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-zinc-400 text-center text-xs min-h-[2rem]">
                      {keyerStats.pressDur > 0 ? `${keyerStats.pressDur} ms` : '-'}
                    </div>
                  </div>
                </div>

                {/* Hand lever brass straight key practice button */}
                <div className="flex flex-col items-center justify-center py-6 bg-zinc-950 border border-zinc-850 rounded relative group">
                  <div className="absolute top-2 left-2 text-[8px] font-mono text-zinc-600">
                    MECHANICAL CW STRAIGHT KEY
                  </div>
                  
                  {/* Brass straight key graphic assembly */}
                  <div className="w-64 h-24 flex items-center justify-center relative select-none">
                    {/* Metal Base plate */}
                    <div className="absolute bottom-4 w-44 h-2.5 bg-zinc-800 border border-zinc-700 rounded shadow-md"></div>
                    {/* Pivot Pillar blocks */}
                    <div className="absolute bottom-6 left-1/3 w-6 h-10 bg-zinc-700 border border-zinc-600 rounded"></div>
                    
                    {/* Brass Key Lever Arm (Pivots slightly upon isKeyerDown) */}
                    <div 
                      style={{ 
                        transformOrigin: '55px 44px',
                        transform: `rotate(${isKeyerDown ? '2.5deg' : '0deg'})` 
                      }}
                      className="absolute left-12 top-6 w-36 h-3 bg-yellow-600 border border-yellow-500 rounded-sm flex items-center justify-end transition-all duration-75 shadow-lg"
                    >
                      {/* Brass Lever knob */}
                      <button
                        onMouseDown={handleKeyStart}
                        onMouseUp={handleKeyEnd}
                        onMouseLeave={handleKeyEnd}
                        onTouchStart={handleKeyStart}
                        onTouchEnd={handleKeyEnd}
                        className={`w-10 h-10 rounded-full border-2 border-zinc-900 cursor-pointer transition transform -translate-y-4 translate-x-2 flex items-center justify-center shadow-md active:scale-95 ${isKeyerDown ? 'bg-yellow-500' : 'bg-yellow-600'}`}
                        style={{ userSelect: 'none', touchAction: 'none' }}
                      />
                    </div>
                  </div>

                  <span className="text-[10px] text-zinc-500 font-mono mt-2">
                    CLICK AND HOLD KNOB OR USE SPACEBAR
                  </span>
                </div>

                {/* Practice Decoded Output */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-zinc-400 font-mono text-xs">Decoded Practice Text</label>
                    <button 
                      onClick={resetKeyerText}
                      className="text-[10px] text-zinc-500 hover:text-zinc-300 transition underline font-mono"
                    >
                      CLEAR
                    </button>
                  </div>
                  <div className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-sm min-h-[4rem] break-all max-h-36 overflow-y-auto uppercase leading-relaxed text-zinc-100 select-text">
                    {keyerDecodedText || <span className="text-zinc-800">TAP SENSORS TO LOG CHARACTERS...</span>}
                  </div>
                </div>
              </div>
            )}
            
          </div>
        </div>
      </div>

      {/* BOTTOM SECTION - MORSE CHEAT SHEET TOGGLE REFERENCE */}
      <div className="w-full max-w-5xl mt-6 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <button
          onClick={() => setShowCheatSheet(!showCheatSheet)}
          className="w-full p-4 flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 hover:bg-zinc-850 transition font-mono text-xs font-semibold text-zinc-400 hover:text-zinc-200"
        >
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-500" />
            <span>MORSE CODE REFERENCE CHEAT SHEET</span>
          </div>
          <span className="text-[10px] bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
            {showCheatSheet ? 'HIDE REFERENCE' : 'SHOW REFERENCE'}
          </span>
        </button>

        {showCheatSheet && (
          <div className="p-5 bg-zinc-950/50 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 font-mono text-xs select-text">
            {Object.entries(MORSE_MAP)
              .filter(([char]) => char !== ' ')
              .map(([char, morse]) => (
                <div key={char} className="flex justify-between bg-zinc-900/40 p-1.5 px-2.5 rounded border border-zinc-850">
                  <span className="text-zinc-500 font-bold">{char}</span>
                  <span className="text-emerald-400 font-extrabold tracking-wider">{morse}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Footer copyright */}
      <div className="w-full max-w-5xl mt-8 mb-6 border-t border-zinc-900 pt-4 text-center font-mono text-[10px] text-zinc-600">
        SM-88 CW TRANSCEIVER TRANS-CODER SYSTEM • LICENSED UNDER MIT LICENSE • PREPARED FOR SMANN
      </div>
    </div>
  );
}

export default App;
