export type ExecRewriteRequiredMatch = {
  code:
    | "apply-patch-heredoc"
    | "temp-patch-file"
    | "interpreter-stdin-heredoc"
    | "generic-heredoc-wrapper";
  summary: string;
};

type RewriteRequiredPattern = ExecRewriteRequiredMatch & {
  regex: RegExp;
};

const REWRITE_REQUIRED_PATTERNS: RewriteRequiredPattern[] = [
  {
    code: "apply-patch-heredoc",
    regex: /\bapply_patch\b[\s\S]*<<-?\s*(?:['"]?[A-Za-z0-9_+-]+['"]?)/iu,
    summary:
      "shell heredoc patch application hides the actual file diff from exec approval and resume flows",
  },
  {
    code: "temp-patch-file",
    regex: /\bcat\b\s*>\s*\/tmp\/[A-Za-z0-9._-]+\.patch\b/iu,
    summary: "temporary patch-file creation hides the real edit intent behind a shell wrapper",
  },
  {
    code: "interpreter-stdin-heredoc",
    regex: /\b(?:python|python3|node|ruby|php)\b\s+-\s*<<-?\s*(?:['"]?[A-Za-z0-9_+-]+['"]?)/iu,
    summary: "stdin-fed interpreter heredocs hide inline code behind a multiline shell wrapper",
  },
  {
    code: "generic-heredoc-wrapper",
    regex: /<<-?\s*(?:['"]?(?:PATCH|EOF|PY|NODE|JS|SH|BASH|ZSH)['"]?)(?:\s|$)/iu,
    summary: "multiline heredoc wrappers are obfuscation-prone for coding/edit flows",
  },
];

export function detectExecRewriteRequired(command: string): ExecRewriteRequiredMatch | null {
  for (const pattern of REWRITE_REQUIRED_PATTERNS) {
    if (pattern.regex.test(command)) {
      return { code: pattern.code, summary: pattern.summary };
    }
  }
  return null;
}

export function isExecRewriteRequiredCommand(command: string): boolean {
  return detectExecRewriteRequired(command) !== null;
}

export function isExecRewriteRequiredText(text: string): boolean {
  return (
    /exec blocked:\s*rewrite required/iu.test(text) || detectExecRewriteRequired(text) !== null
  );
}

export function buildExecRewriteRequiredResumeHint(): string {
  return [
    "Your previous run hit a blocked exec file-edit wrapper.",
    "Rewrite that step using apply_patch/edit/write, or replace it with one direct build/test/git/script command.",
    "Do not wait for approval and do not rerun the same heredoc, temp patch file, or stdin-fed inline interpreter wrapper.",
  ].join(" ");
}

export function buildExecRewriteRequiredMessage(command: string): string {
  const match = detectExecRewriteRequired(command);
  const reason = match ? `${match.code}: ${match.summary}.` : "obfuscation-prone shell wrapper.";
  return [
    `exec blocked: rewrite required (${reason})`,
    "Do not wait for approval and do not rerun the same multiline shell wrapper.",
    "Use `apply_patch`, `edit`, or `write` for source edits, or use one direct build/test/git/script command with `exec`.",
    "Avoid shell heredocs, temporary patch files, and stdin-fed inline interpreter scripts in coding flows.",
  ].join("\n");
}

export function buildExecRewriteRequiredUserMessage(): string {
  return (
    "Command did not run: rewrite required. Use `apply_patch`/`edit`/`write` for file changes, " +
    "or a direct single build/test/git/script command instead of heredocs, temp patch files, or stdin-fed inline interpreters."
  );
}
