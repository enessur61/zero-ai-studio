import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  DownloadCloud,
  Lock,
  Rocket,
  XCircle,
} from 'lucide-react';
import type { ModelStatus } from '../types/zero.ts';

export function StatusLabel({ status }: { status: ModelStatus }) {
  if (status === 'FUNKTIONIERT') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        FUNKTIONIERT
      </span>
    );
  }
  if (status === 'Ready for Deployment') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-300 whitespace-nowrap shrink-0">
        <Rocket className="w-3.5 h-3.5 shrink-0" />
        Ready for Deployment
      </span>
    );
  }
  if (status === 'LOKAL INSTALLIERT') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400 whitespace-nowrap shrink-0">
        <Cpu className="w-3.5 h-3.5 shrink-0" />
        LOKAL INSTALLIERT
      </span>
    );
  }
  if (status === 'BROWSER TEST ERFORDERLICH') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300 whitespace-nowrap shrink-0">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        BROWSER TEST ERFORDERLICH
      </span>
    );
  }
  if (status === 'INSTALLATION ERFORDERLICH') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
        <DownloadCloud className="w-3.5 h-3.5 shrink-0" />
        INSTALLATION ERFORDERLICH
      </span>
    );
  }
  if (status === 'FREE-TIER AUSGESCHÖPFT') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        FREE-TIER AUSGESCHÖPFT
      </span>
    );
  }
  if (status === 'GESPERRT') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
        <Lock className="w-3.5 h-3.5 shrink-0" />
        GESPERRT
      </span>
    );
  }
  if (status === 'NICHT KOMPATIBEL') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap shrink-0">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        NICHT KOMPATIBEL
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      ADAPTER FEHLT
    </span>
  );
}
