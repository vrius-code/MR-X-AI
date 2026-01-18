
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { SYSTEM_INSTRUCTION } from './constants';
import { encode, decode, decodeAudioData } from './utils/audio-utils';

// Icons
const MicIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
  </svg>
);

const StopIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const SendIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [status, setStatus] = useState<string>('NEURAL CORE IDLE');
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');
  const [textMessage, setTextMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('mr_x_history_v2');
    if (saved) setHistory(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (history.length > 0) localStorage.setItem('mr_x_history_v2', JSON.stringify(history));
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, currentInput, currentOutput]);

  const stopSession = () => {
    sessionPromiseRef.current?.then(s => s.close()).catch(() => {});
    streamRef.current?.getTracks().forEach(t => t.stop());
    inputAudioCtxRef.current?.close().catch(() => {});
    setIsActive(false);
    setIsConnecting(false);
    setStatus('SYSTEM OFFLINE');
  };

  const startSession = async () => {
    if (isConnecting || isActive) return;
    try {
      setIsConnecting(true);
      setStatus('TUNNELING...');
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      inputAudioCtxRef.current = new AudioContext({ sampleRate: 16000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setIsActive(true);
            setIsConnecting(false);
            setStatus('CORE ACTIVE');
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++) int16[i] = input[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' }
              }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (m) => {
            if (m.serverContent?.inputTranscription) setCurrentInput(prev => prev + m.serverContent!.inputTranscription!.text);
            if (m.serverContent?.outputTranscription) setCurrentOutput(prev => prev + m.serverContent!.outputTranscription!.text);
            if (m.serverContent?.turnComplete) {
              setHistory(prev => [...prev, { role: 'user', text: currentInput || "(Voice)", time: new Date().toISOString() }, { role: 'agent', text: currentOutput, time: new Date().toISOString() }]);
              setCurrentInput(''); setCurrentOutput('');
            }
            const audio = m.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio && audioContextRef.current) {
              const ctx = audioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }
            if (m.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: () => stopSession(),
          onclose: () => stopSession()
        }
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (e) {
      setIsConnecting(false);
      setStatus('ACCESS DENIED');
    }
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textMessage.trim() || isTyping) return;
    const msg = textMessage.trim();
    setTextMessage('');
    setIsTyping(true);
    setHistory(prev => [...prev, { role: 'user', text: msg, time: new Date().toISOString() }]);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        contents: [{ role: 'user', parts: [{ text: msg }] }],
        config: { systemInstruction: SYSTEM_INSTRUCTION }
      });
      setHistory(prev => [...prev, { role: 'agent', text: res.text, time: new Date().toISOString() }]);
    } catch {
      setHistory(prev => [...prev, { role: 'agent', text: "Error: Neural link broken.", time: new Date().toISOString() }]);
    } finally { setIsTyping(false); }
  };

  return (
    <div className="min-h-screen flex flex-col max-w-5xl mx-auto p-4 md:p-6 lg:p-8">
      {/* Dynamic Header */}
      <header className="flex flex-col sm:flex-row items-center justify-between mb-8 gap-4">
        <div className="flex items-center gap-5">
          <div className="relative group">
            <div className={`absolute -inset-1 bg-gradient-to-r from-red-600 to-cyan-500 rounded-2xl blur opacity-25 group-hover:opacity-100 transition duration-1000 ${isActive ? 'animate-pulse' : ''}`}></div>
            <div className="relative w-16 h-16 bg-slate-950 rounded-2xl border border-white/10 flex items-center justify-center overflow-hidden">
                <span className="text-4xl font-black cyber-font bg-clip-text text-transparent bg-gradient-to-br from-red-500 to-cyan-400">X</span>
            </div>
          </div>
          <div>
            <h1 className="text-3xl font-bold cyber-font tracking-[0.2em] bg-clip-text text-transparent bg-gradient-to-r from-red-500 via-white to-cyan-400">MR X CORE</h1>
            <div className="flex items-center gap-2 mt-1">
               <span className="text-[10px] text-red-500 font-bold uppercase tracking-widest">Threat Analysis</span>
               <span className="text-slate-700">|</span>
               <span className="text-[10px] text-cyan-400 font-bold uppercase tracking-widest">Neural Defense</span>
            </div>
          </div>
        </div>

        {/* Highlighted Developer Branding */}
        <div className="relative group">
           <div className="absolute -inset-0.5 bg-gradient-to-r from-red-600 to-cyan-500 rounded-lg blur opacity-75 group-hover:opacity-100 transition"></div>
           <div className="relative px-6 py-2 bg-slate-950 rounded-lg flex flex-col items-center">
              <span className="text-[9px] text-slate-400 uppercase font-bold tracking-[0.3em]">Developer By</span>
              <span className="text-lg font-black cyber-font text-white tracking-widest">MR SAM</span>
           </div>
        </div>
      </header>

      {/* Main Terminal Area */}
      <main className="flex-1 flex flex-col glass-panel-cyber rounded-[2.5rem] overflow-hidden mb-6 border border-white/5 shadow-2xl relative">
        <div className="scanning-beam"></div>
        
        <div className="px-8 py-4 border-b border-white/5 flex items-center justify-between bg-slate-900/40">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-red-500 animate-ping' : isConnecting ? 'bg-cyan-400 animate-pulse' : 'bg-slate-700'}`}></div>
            <span className={`text-[11px] font-black uppercase tracking-[0.2em] ${isActive ? 'text-red-500' : isConnecting ? 'text-cyan-400' : 'text-slate-500'}`}>
              {status}
            </span>
          </div>
          <div className="flex items-center gap-4">
             <span className="text-[10px] text-slate-600 font-mono hidden md:block">ENCRYPTION: AES_256_GCM</span>
             <button onClick={() => { if(confirm("Purge logs?")) { setHistory([]); localStorage.removeItem('mr_x_history_v2'); } }} className="text-[10px] text-red-500/50 hover:text-red-500 font-bold uppercase tracking-widest border border-red-500/20 px-3 py-1 rounded-full transition-all">Clear Logs</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-8 scroll-smooth">
          {history.length === 0 && !currentInput && !currentOutput && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-8">
              <div className="w-24 h-24 border-2 border-dashed border-cyan-500/20 rounded-full flex items-center justify-center animate-spin-slow">
                 <MicIcon />
              </div>
              <div className="space-y-3">
                <h2 className="text-3xl font-bold cyber-font tracking-widest text-white">SYSTEM READY</h2>
                <p className="text-slate-500 max-w-sm text-sm font-medium leading-relaxed">Neural Core v3.1 online. Awaiting security command or encrypted voice transmission.</p>
              </div>
            </div>
          )}
          
          {history.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-6 py-4 shadow-2xl ${
                msg.role === 'user' 
                ? 'bg-gradient-to-br from-red-600/10 to-red-900/20 border-r-4 border-red-600 text-red-50' 
                : 'bg-gradient-to-br from-cyan-900/10 to-slate-900/40 border-l-4 border-cyan-500 text-slate-200'
              }`}>
                <p className="text-sm md:text-base leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                <div className="mt-3 flex items-center gap-3 opacity-30 text-[9px] uppercase font-black tracking-widest">
                  <span>{msg.role}</span>
                  <span className="w-1 h-1 bg-current rounded-full"></span>
                  <span>{new Date(msg.time).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
          ))}

          {currentInput && (
            <div className="flex justify-end">
              <div className="px-6 py-4 rounded-2xl bg-red-500/5 border-r-4 border-red-400 text-red-300 italic text-sm">
                {currentInput}<span className="animate-pulse">_</span>
              </div>
            </div>
          )}
          {currentOutput && (
            <div className="flex justify-start">
              <div className="px-6 py-4 rounded-2xl bg-cyan-500/5 border-l-4 border-cyan-400 text-cyan-300 text-sm">
                {currentOutput}
              </div>
            </div>
          )}
          {isTyping && (
             <div className="flex justify-start">
                <div className="bg-slate-900 px-6 py-3 rounded-2xl border-l-4 border-red-500 flex gap-2">
                   <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce"></div>
                   <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                   <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                </div>
             </div>
          )}
          <div ref={chatEndRef} />
        </div>
      </main>

      <footer className="w-full space-y-6">
        <form onSubmit={handleSendText} className="relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-red-600/20 to-cyan-500/20 rounded-2xl blur opacity-50 group-hover:opacity-100 transition"></div>
            <input 
                type="text"
                value={textMessage}
                onChange={(e) => setTextMessage(e.target.value)}
                placeholder="EXECUTE CMD..."
                className="relative w-full bg-slate-950 border border-white/10 rounded-2xl px-8 py-5 text-white focus:outline-none focus:border-cyan-500/50 transition-all code-font text-base tracking-widest pr-20 shadow-inner"
            />
            <button 
                type="submit"
                disabled={!textMessage.trim() || isTyping}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-gradient-to-r from-red-600 to-cyan-600 text-white rounded-xl hover:scale-105 transition-all disabled:opacity-20"
            >
                <SendIcon />
            </button>
        </form>

        <div className="flex flex-col sm:flex-row gap-4">
            <button
              disabled={isConnecting}
              onClick={isActive ? stopSession : startSession}
              className={`flex-1 py-5 rounded-2xl font-black cyber-font text-xl uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-4 shadow-xl ${
                isActive 
                ? 'bg-red-500/10 border-2 border-red-600 text-red-500' 
                : 'bg-gradient-to-r from-red-600 to-cyan-600 text-white hover:opacity-90 active:scale-[0.98]'
              }`}
            >
              {isConnecting ? <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin"></div> : isActive ? <StopIcon /> : <MicIcon />}
              {isConnecting ? 'TUNNELING...' : isActive ? 'TERMINATE VOICE' : 'INITIATE NEURAL VOICE'}
            </button>
        </div>

        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 px-6 py-4 border-t border-white/5">
          <div className="flex items-center gap-4">
             <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-600"></span>
                <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Master: MR SAM</span>
             </div>
             <span className="text-slate-800">|</span>
             <span className="text-[10px] text-cyan-600 font-mono">TOKEN: @MR_SAM_VRIUS</span>
          </div>
          
          <div className="flex items-center gap-6">
            <a 
              href="https://t.me/MR_SAM_VRIUS" 
              target="_blank" 
              className="text-[10px] text-slate-500 hover:text-cyan-400 font-black uppercase tracking-widest transition-colors flex items-center gap-2"
            >
              <span className="p-1 bg-cyan-500/10 rounded">TG</span>
              @MR_SAM_VRIUS
            </a>
            <span className="text-slate-800">|</span>
            <div className="text-[10px] text-slate-700 font-bold uppercase tracking-[0.2em] select-none">
               STAY_SAFE_STAY_SECURE
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
