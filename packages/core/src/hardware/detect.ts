import os from 'node:os';

export type Platform = 'darwin' | 'linux' | 'win32' | 'other';

export interface HardwareInfo {
  platform: Platform;
  arch: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryGB: number;
  appleSilicon: boolean;
}

const GIB = 1024 ** 3;

function normalisePlatform(raw: NodeJS.Platform): Platform {
  if (raw === 'darwin' || raw === 'linux' || raw === 'win32') return raw;
  return 'other';
}

export function detectHardware(): HardwareInfo {
  const platform = normalisePlatform(os.platform());
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model.trim() ?? 'unknown';
  const arch = os.arch();

  return {
    platform,
    arch,
    osRelease: os.release(),
    cpuModel,
    cpuCount: cpus.length,
    totalMemoryGB: Math.round((os.totalmem() / GIB) * 10) / 10,
    appleSilicon: platform === 'darwin' && arch === 'arm64',
  };
}
