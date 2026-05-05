#!/usr/bin/env python3
"""
Complete module extraction - creates terminal.ts, notifications.ts, and new index.ts
"""

import shutil
from pathlib import Path

def read_lines(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.readlines()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    src_dir = Path('src')
    index_path = src_dir / 'index.ts'
    
    # Backup
    shutil.copy(index_path, index_path.with_suffix('.ts.backup'))
    
    lines = read_lines(index_path)
    print(f"Read {len(lines)} lines")
    
    # Find boundaries
    import_end = 18  # Line after "} from \"./shared.js\";"
    log_end = 117    # Line after log function
    terminal_start = 273  # "// ── Terminal Title"
    terminal_end = 375    # "async function showTimerToast"
    toast_start = 375     # "async function showTimerToast"
    toast_end = 443       # "// Rough token estimation"
    
    # Extract terminal section (includes formatMessage and formatDuration duplicates)
    terminal_lines = lines[terminal_start:terminal_end]
    
    # Create terminal.ts
    terminal_content = '''import { type PluginConfig, type SessionState, formatDuration } from "./shared.js";

export interface TerminalDeps {
  config: Pick<PluginConfig, "terminalTitleEnabled" | "terminalProgressEnabled" | "stallTimeoutMs">;
  sessions: Map<string, SessionState>;
  log: (message: string, ...args: unknown[]) => void;
}

export function createTerminalModule(deps: TerminalDeps) {
  const { config, sessions, log } = deps;

'''
    
    # Add terminal functions (skip the formatMessage and formatDuration duplicates)
    for line in terminal_lines:
        if 'function formatMessage' in line:
            break
        terminal_content += line
    
    terminal_content += '''
  return { updateTerminalTitle, clearTerminalTitle, updateTerminalProgress, clearTerminalProgress, registerStatusLineHook };
}
'''
    
    write_file(src_dir / 'terminal.ts', terminal_content)
    print("Created terminal.ts")
    
    # Extract toast section
    toast_lines = lines[toast_start:toast_end]
    
    # Create notifications.ts
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

'''
    
    for line in toast_lines:
        notif_content += line
    
    notif_content += '''
  return { showTimerToast, startTimerToast, stopTimerToast };
}
'''
    
    write_file(src_dir / 'notifications.ts', notif_content)
    print("Created notifications.ts")
    
    # Now create new index.ts
    new_lines = []
    
    # 1. Add imports (insert after line 18)
    new_lines.extend(lines[:import_end])
    new_lines.append('import { createTerminalModule } from "./terminal.js";\n')
    new_lines.append('import { createNotificationModule } from "./notifications.js";\n')
    
    # 2. Add body up to log_end
    new_lines.extend(lines[import_end:log_end])
    
    # 3. Add module instantiations
    new_lines.append('\n')
    new_lines.append('  const terminal = createTerminalModule({ config, sessions, log });\n')
    new_lines.append('\n')
    new_lines.append('  const notifications = createNotificationModule({ config, sessions, log, isDisposed: () => isDisposed, input });\n')
    
    # 4. Add rest of file (skip terminal and toast sections)
    new_lines.extend(lines[log_end:terminal_start])
    new_lines.extend(lines[toast_end:])
    
    # 5. Update function calls
    new_content = ''.join(new_lines)
    new_content = new_content.replace('registerStatusLineHook();', 'terminal.registerStatusLineHook(input);')
    new_content = new_content.replace('updateTerminalTitle(sid)', 'terminal.updateTerminalTitle(sid)')
    new_content = new_content.replace('updateTerminalProgress(sid)', 'terminal.updateTerminalProgress(sid)')
    new_content = new_content.replace('clearTerminalTitle()', 'terminal.clearTerminalTitle()')
    new_content = new_content.replace('clearTerminalProgress()', 'terminal.clearTerminalProgress()')
    new_content = new_content.replace('startTimerToast(sid)', 'notifications.startTimerToast(sid)')
    new_content = new_content.replace('stopTimerToast(sid)', 'notifications.stopTimerToast(sid)')
    
    write_file(index_path, new_content)
    print(f"Created new index.ts: {len(new_lines)} lines")
    print("Done!")

if __name__ == '__main__':
    main()
