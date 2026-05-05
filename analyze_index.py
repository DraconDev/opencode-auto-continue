#!/usr/bin/env python3
"""Extract modules from index.ts using precise line ranges"""

import sys

def read_lines(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.readlines()

def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

def find_line_index(lines, pattern, start=0):
    """Find the index of the first line matching pattern"""
    for i in range(start, len(lines)):
        if pattern in lines[i]:
            return i
    return -1

def extract_section(lines, start_marker, end_marker):
    """Extract lines from start_marker to end_marker (exclusive)"""
    start_idx = find_line_index(lines, start_marker)
    end_idx = find_line_index(lines, end_marker, start_idx)
    if start_idx == -1 or end_idx == -1:
        return None, start_idx, end_idx
    return lines[start_idx:end_idx], start_idx, end_idx

def main():
    lines = read_lines('src/index.ts')
    print(f"Read {len(lines)} lines from src/index.ts")
    
    # Find key sections
    sections = {
        'terminal_title': ('// ── Terminal Title', '// ── Timer Toast'),
        'timer_toast': ('async function showTimerToast', '// Rough token estimation'),
    }
    
    for name, (start, end) in sections.items():
        section_lines, start_idx, end_idx = extract_section(lines, start, end)
        if section_lines:
            print(f"\n{name}: lines {start_idx+1}-{end_idx} ({len(section_lines)} lines)")
            print(f"  First: {section_lines[0].strip()[:60]}")
            print(f"  Last:  {section_lines[-1].strip()[:60]}")
        else:
            print(f"\n{name}: NOT FOUND (start={start_idx}, end={end_idx})")

if __name__ == '__main__':
    main()
