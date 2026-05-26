import { useState, useEffect } from 'react';

interface SplashScreenProps {
  onComplete: () => void;
}

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const [phase, setPhase] = useState(0);
  // Phase 0: Dark screen
  // Phase 1: Logo appears (glow)
  // Phase 2: Text appears
  // Phase 3: Warning text
  // Phase 4: Fade out

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),    // Logo after 0.5s
      setTimeout(() => setPhase(2), 1500),   // Text after 1.5s
      setTimeout(() => setPhase(3), 3000),   // Warning after 3s
      setTimeout(() => setPhase(4), 5500),   // Fade out after 5.5s
      setTimeout(() => onComplete(), 6500),  // Done after 6.5s
    ];
    return () => timers.forEach(clearTimeout);
  }, [onComplete]);

  return (
    <div className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black transition-opacity duration-1000 ${phase >= 4 ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
      {/* Animated background particles */}
      <div className="absolute inset-0 overflow-hidden">
        {Array.from({ length: 30 }).map((_, i) => (
          <div key={i} className="absolute w-1 h-1 bg-red-500/20 rounded-full animate-float"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 5}s`,
              animationDuration: `${3 + Math.random() * 4}s`,
            }} />
        ))}
      </div>

      {/* Radial glow behind logo */}
      <div className={`absolute w-96 h-96 rounded-full transition-all duration-2000 ${phase >= 1 ? 'opacity-30 scale-100' : 'opacity-0 scale-50'}`}
        style={{ background: 'radial-gradient(circle, rgba(220,38,38,0.4) 0%, transparent 70%)' }} />

      {/* Main content */}
      <div className="relative flex flex-col items-center">
        {/* Logo */}
        <div className={`transition-all duration-1000 ${phase >= 1 ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-50 translate-y-10'}`}>
          <div className="relative">
            {/* Outer glow ring */}
            <div className={`absolute -inset-4 rounded-2xl transition-all duration-1500 ${phase >= 1 ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: 'conic-gradient(from 0deg, #dc2626, #f97316, #dc2626)', filter: 'blur(15px)' }} />
            
            {/* Logo box */}
            <div className="relative w-28 h-28 rounded-2xl bg-gradient-to-br from-red-600 via-red-500 to-orange-500 flex items-center justify-center shadow-2xl shadow-red-900/80">
              <span className="text-white font-black text-4xl tracking-tight">MMB</span>
            </div>
          </div>
        </div>

        {/* Title */}
        <div className={`mt-8 text-center transition-all duration-1000 ${phase >= 2 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
          <h1 className="text-white font-black text-3xl tracking-wider">MMB AGENT</h1>
          <div className="flex items-center justify-center gap-2 mt-2">
            <div className="w-8 h-px bg-gradient-to-r from-transparent to-red-500" />
            <span className="text-red-400 text-sm font-medium tracking-widest">24 / 7</span>
            <div className="w-8 h-px bg-gradient-to-l from-transparent to-red-500" />
          </div>
          <p className="text-gray-400 text-sm mt-3 font-medium">YouTube Growth Automation</p>
          <p className="text-gray-600 text-xs mt-1">v1.5.0 • by Kuldeep</p>
        </div>

        {/* Warning / License text */}
        <div className={`mt-10 text-center transition-all duration-1000 ${phase >= 3 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}`}>
          <div className="bg-red-950/50 border border-red-800/50 rounded-xl px-6 py-3 max-w-md">
            <p className="text-red-400 text-xs font-bold tracking-wide">⚠️ LICENSED SOFTWARE</p>
            <p className="text-red-300/70 text-xs mt-1">Running this software without owner's permission is strictly prohibited.</p>
            <p className="text-gray-500 text-xs mt-2">© 2026 MMB Agent • All Rights Reserved</p>
          </div>
        </div>

        {/* Loading dots */}
        <div className={`mt-6 flex gap-1.5 transition-all duration-500 ${phase >= 2 ? 'opacity-100' : 'opacity-0'}`}>
          <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}
