#!/usr/bin/env python3
"""Extract modules from index.ts safely"""

import re

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    index_ts = read_file('src/index.ts')
    
    # Extract terminal functions (lines 274-363 in original)
    terminal_pattern = r'(\s+// ── Terminal Title.*?)(?=\s+// ── Timer Toast)'
    terminal_match = re.search(terminal_pattern, index_ts, re.DOTALL)
    
    if terminal_match:
        terminal_section = terminal_match.group(1)
        print(f"Found terminal section: {len(terminal_section)} chars")
        
        # Create terminal.ts
        terminal_content = '''import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";

export interface TerminalDeps {
  config: Pick<PluginConfig, "terminalTitleEnabled" | "terminalProgressEnabled" | "stallTimeoutMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
}

export function createTerminalModule(deps: TerminalDeps) {
  const { config, sessions, log } = deps;

''' + terminal_section.strip() + '''

  return { updateTerminalTitle, clearTerminalTitle, updateTerminalProgress, clearTerminalProgress, registerStatusLineHook };
}
'''
        write_file('src/terminal.ts', terminal_content)
        print("Created src/terminal.ts")
    
    # Extract notification functions
    notif_pattern = r'(\s+async function showTimerToast.*?)(?=\s+// Rough token estimation)'
    notif_match = re.search(notif_pattern, index_ts, re.DOTALL)
    
    if notif_match:
        notif_section = notif_match.group(1)
        print(f"Found notification section: {len(notif_section)} chars")
        
        notif_content = '''import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";

export interface NotificationDeps {
  config: Pick<PluginConfig, "timerToastEnabled" | "timerToastIntervalMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
  isDisposed: () => boolean;
  input: unknown;
}

export function createNotificationModule(deps: NotificationDeps) {
  const { config, sessions, log, isDisposed, input } = deps;

''' + notif_section.strip() + '''

  return { showTimerToast, startTimerToast, stopTimerToast };
}
'''
        write_file('src/notifications.ts', notif_content)
        print("Created src/notifications.ts")

if __name__ == '__main__':
    main()
