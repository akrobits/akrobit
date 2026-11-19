import React from 'react';
import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';

interface WelcomeSplashProps {
  onEnter: () => void;
}

export const WelcomeSplash: React.FC<WelcomeSplashProps> = ({ onEnter }) => {
  return (
    <div className="relative min-h-[100dvh] w-full flex flex-col bg-[#145f96] overflow-hidden select-none">
      {/* Unified Corporate Blue Canvas (#145f96 — exact background color of official logo) */}
      <div className="relative flex-1 w-full flex flex-col items-center justify-between bg-[#145f96] overflow-hidden">
        {/* Top Dead-Centered Official Akrobit Logo seamlessly embedded in #145f96 */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.55 }}
          className="w-full flex items-center justify-center px-4 pt-5 pb-2 z-20"
        >
          <img
            src="/akrobit-logo-tight.png"
            alt="Akrobit"
            className="h-12 sm:h-16 w-auto mx-auto block object-contain"
          />
        </motion.div>

        {/* Photo Container on same #145f96 corporate blue with cinematic zoom-from-depth entrance */}
        <div className="w-full flex-1 flex items-center justify-center overflow-hidden bg-[#145f96] px-4">
          <motion.div
            initial={{ scale: 1.18, opacity: 0.35 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 1.45, ease: [0.16, 1, 0.3, 1] }}
            className="w-full h-full flex items-center justify-center"
          >
            <img
              src="/assets/aistudio/1774934365982_5746af37.png"
              alt="Akrobit — Lic. Elder Rafael Rocha"
              className="w-full h-full max-h-[calc(100dvh-215px)] mx-auto block object-contain"
            />
          </motion.div>
        </div>

        {/* Dead-Centered Signature on same #145f96 background in exact Akrobit Brand Manual green (#a1d63e) */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.55 }}
          className="w-full bg-[#145f96] px-4 py-3 sm:py-4 flex items-center justify-center text-center"
        >
          <p className="w-full text-center font-signature font-bold text-2xl sm:text-3xl tracking-wide text-[#a1d63e]">
            Lic. Elder Rafael Rocha
          </p>
        </motion.div>
      </div>

      {/* Bottom Corporate Orange Strip (#df7729 — exact tone from Akrobit Brand Manual) */}
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-30 w-full bg-[#df7729] shadow-[0_-8px_28px_rgba(0,0,0,0.22)]"
      >
        <div className="mx-auto max-w-5xl px-4 py-3.5 sm:py-4 flex items-center justify-center">
          <button
            type="button"
            onClick={onEnter}
            className="w-full sm:w-auto min-w-[260px] min-h-[50px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#145f96] ring-2 ring-white/25 hover:ring-white/60 active:scale-[0.99] px-6 py-2.5 text-white shadow-md transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <span className="text-base sm:text-lg font-semibold tracking-tight leading-none">
              Acceder a
            </span>
            <img
              src="/akrobit-logo-tight.png"
              alt="Akrobit"
              className="h-5 sm:h-6 w-auto object-contain"
            />
            <ArrowRight className="w-5 h-5 text-[#a1d63e] ml-1 shrink-0" />
          </button>
        </div>
      </motion.div>
    </div>
  );
};
