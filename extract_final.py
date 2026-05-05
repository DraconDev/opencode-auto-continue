#!/usr/bin/env python3
"""
Safe module extraction - makes all changes in memory, writes once.
"""

import shutil
from pathlib import Path

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

def main():
    src_dir = Path('src')
    index_path = src_dir / 'index.ts'
    
    # Read original
    original = read_file(index_path)
    lines = original.split('\n')
    
    print(f"Original: {len(lines)} lines")
    
    # Find line indices for key sections
    import_end = None  # Line after "} from \"./shared.js\";"
    log_end = None     # Line after log function closing brace
    terminal_start = None  # Line with "// ── Terminal Title"
    terminal_end = None    # Line before "async function showTimerToast"
    
    for i, line in enumerate(lines):
        if '} from "./shared.js";' in line:
            import_end = i + 1
        elif 'function log(...args: unknown[])' in line:
            # Find the closing brace of log function
            brace_count = 0
            for j in range(i, min(i + 30, len(lines))):
                brace_count += lines[j].count('{')
                brace_count -= lines[j].count('}')
                if brace_count == 0 and j > i:
                    log_end = j + 1
                    break
        elif '// ── Terminal Title' in line:
            terminal_start = i
        elif 'async function showTimerToast' in line:
            if terminal_end is None:
                terminal_end = i
    
    print(f"Import end: {import_end}")
    print(f"Log end: {log_end}")
    print(f"Terminal: {terminal_start}-{terminal_end}")
    
    if not all([import_end, log_end, terminal_start, terminal_end]):
        print("ERROR: Could not find all section boundaries!")
        return
    
    # Extract terminal section
    terminal_lines = lines[terminal_start:terminal_end]
    terminal_content = '\n'.join(terminal_lines)
    print(f"Terminal section: {len(terminal_lines)} lines")
    
    # For now, just verify we can identify the sections correctly
    print("\nSuccess - sections identified correctly")

if __name__ == '__main__':
    main()
