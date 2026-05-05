#!/usr/bin/env python3
"""
Extract modules from index.ts safely.
This script creates new module files and a new index.ts with proper imports.
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
    
    # Backup original
    shutil.copy(index_path, index_path.with_suffix('.ts.backup'))
    print(f"Backed up to {index_path}.backup")
    
    index_content = read_file(index_path)
    lines = index_content.split('\n')
    
    print(f"Read {len(lines)} lines from index.ts")
    
    # Find section boundaries by searching for comment markers
    terminal_start = None
    terminal_end = None
    toast_start = None
    toast_end = None
    
    for i, line in enumerate(lines):
        if '─ Terminal Title' in line:
            terminal_start = i
        elif '─ Timer Toast' in line and terminal_start is not None and terminal_end is None:
            terminal_end = i
        elif 'async function showTimerToast' in line:
            toast_start = i
        elif '─ Rough token estimation' in line and toast_start is not None:
            toast_end = i
    
    print(f"Terminal: {terminal_start}-{terminal_end}")
    print(f"Toast: {toast_start}-{toast_end}")

if __name__ == '__main__':
    main()
