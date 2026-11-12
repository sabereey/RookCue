export function runPeerAcceptance(options: { executable: string; prefix?: string[] }): Promise<{
  scope: 'same-host-loopback'; version: string; executableSHA256: string; checks: string[]; interruptedSession: string; path: string;
}>;
