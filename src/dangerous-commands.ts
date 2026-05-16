/**
 * Dangerous command detection for AI coding sessions.
 *
 * Two layers:
 *   Layer 1 — Proactive: inject the blocklist into session context at startup
 *   Layer 2 — Reactive: detect dangerous commands post-execution and abort
 *
 * Only commands that AI should NEVER need are blocked.
 */

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // Privilege escalation
  /\bsudo\b/i,

  // Destructive file removal (only rm -rf / or rm -rf ~, not rm in general)
  /\brm\s+(-[a-z]*f[a-z]*\s+)?(?:\/|~(?:\s|$|\/)|\$HOME(?:$|\s|\/)|\/home(?:\/|$|\s))/i,

  // Insecure permissions
  /\bchmod\s+(?:-R\s+)?777\b/i,

  // Filesystem formatting
  /\bmkfs\b/i,

  // Raw disk writes
  /\bdd\b[\s\S]*?\bof=\/dev\//i,

  // Arbitrary code execution from strings
  /\b(?:eval|exec)\s+["']/i,

  // Remote code execution via pipe-to-shell
  /\b(?:curl|wget)\s+.*?\|.*?\b(?:sh|bash|zsh|ksh|dash)\b/i,

  // Netcat — no valid AI use case; require command context to avoid matching English words like "since"
  /\bnc\s+/i,
  /\bncat\b/i,

  // Remote access — AI should never SSH/SCP/SFTP
  /\bssh\s+/i,
  /\bscp\s+/i,
  /\bsftp\s+/i,
];

export function containsDangerousCommand(text: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pat) => pat.test(text));
}

export function formatDangerousBlocklist(): string {
  return [
    "- `sudo` — privilege escalation (AI must never escalate to root)",
    "- `rm -rf /` or `rm -rf ~` — destructive file removal (use `rm` safely)",
    "- `chmod 777` — insecure permissions (never the right fix)",
    "- `mkfs` — filesystem formatting (destructive)",
    "- `dd of=/dev/...` — raw disk writes (destructive)",
    "- `eval`/`exec` with string arguments — arbitrary code execution",
    "- `curl|wget ... | sh` — remote code execution via pipe-to-shell",
    "- `nc`/`ncat` — netcat (no valid use case in coding)",
    "- `ssh`/`scp`/`sftp` — remote access (do not connect to external hosts)",
  ].join("\n");
}

export const DANGEROUS_COMMAND_WARNING =
  `## ⚠️ Blocked: Dangerous Command\n\n` +
  `This session attempted to run a command that is blocked by policy. ` +
  `The command was:\n\n` +
  `\`\`\`\n{command}\n\`\`\`\n\n` +
  `The session has been aborted. If you genuinely need this command, ` +
  `explain why and the operation can be approved manually.\n\n` +
  `### Blocked Commands\n\n` +
  formatDangerousBlocklist();
