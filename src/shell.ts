// The shell splitter both guards use. It reads a command line the way the
// shell would, closely enough for a guard, and never runs anything.

/** A simple command, as the shell would run it. */
export interface Cmd {
  /** Its words as written, wrappers and assignments included. */
  words: string[];
  /** The words the program runs with: leading assignments, keywords and wrappers stripped. */
  argv: string[];
  /** The program's file name, argv[0] without its folder; "" when nothing runs. */
  name: string;
  /** The wrappers stripped, such as sudo or xargs. */
  wrappers: string[];
  /** Whether a wrapper runs the program in another folder, as env -C does. */
  chdir: boolean;
  redirects: string[];
  heredocs: string[];
  /** Code for an interpreter this splitter can't read, such as python -c's or what is piped into node. */
  code: string[];
}

// A simple command as split, before it is unwrapped. `from` is the command
// that pipes into it.
interface Raw {
  words: string[];
  redirects: string[];
  heredocs: string[];
  from?: Raw;
}

export const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\") k++;
    else if (ch === "'") {
      const j = s.indexOf("'", k + 1);
      if (j < 0) return s.length;
      k = j;
    } else if (ch === '"') {
      let m = k + 1;
      while (m < s.length && s[m] !== '"') m += s[m] === "\\" ? 2 : 1;
      k = m;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return k;
  }
  return s.length;
}

/**
 * Splits a command line into simple commands the way the shell would, closely
 * enough for a guard: quotes, escapes, ; & | && || ( ), newlines, comments,
 * redirections, here-documents, and the commands inside $( ) and backticks.
 */
function splitShell(src: string, depth = 0): Raw[] {
  const out: Raw[] = [];
  let cmd: Raw = { words: [], redirects: [], heredocs: [] };
  let tok = "";
  let inTok = false;
  let redirectNext = false;
  const pending: { delim: string; strip: boolean; cmd: Raw }[] = [];
  const endTok = () => {
    if (!inTok) return;
    if (redirectNext) cmd.redirects.push(tok);
    else cmd.words.push(tok);
    redirectNext = false;
    tok = "";
    inTok = false;
  };
  const endCmd = () => {
    endTok();
    if (cmd.words.length || cmd.redirects.length) out.push(cmd);
    cmd = { words: [], redirects: [], heredocs: [] };
    redirectNext = false;
  };
  const sub = (text: string) => {
    if (depth < 8) out.push(...splitShell(text, depth + 1));
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] !== "\n") {
        tok += src[i + 1] ?? "";
        inTok = true;
      }
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      tok += src.slice(i + 1, end);
      inTok = true;
      i = end + 1;
    } else if (c === '"') {
      inTok = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          tok += src[i + 1];
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(") {
          const j = matchParen(src, i + 1);
          sub(src.slice(i + 2, j));
          tok += src.slice(i, j + 1);
          i = j + 1;
        } else if (src[i] === "`") {
          const j = src.indexOf("`", i + 1);
          const end = j < 0 ? src.length : j;
          sub(src.slice(i + 1, end));
          i = end + 1;
        } else tok += src[i++];
      }
      i++;
    } else if (c === "$" && src[i + 1] === "(") {
      const j = matchParen(src, i + 1);
      sub(src.slice(i + 2, j));
      tok += "$(…)";
      inTok = true;
      i = j + 1;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      sub(src.slice(i + 1, end));
      tok += "`…`";
      inTok = true;
      i = end + 1;
    } else if (c === "#" && !inTok) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? src.length : j;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      endTok();
      let k = i + 2;
      const strip = src[k] === "-";
      if (strip) k++;
      while (src[k] === " " || src[k] === "\t") k++;
      let delim = "";
      while (k < src.length && !/[\s;&|<>()]/.test(src[k])) {
        if (src[k] === "'" || src[k] === '"') {
          const j = src.indexOf(src[k], k + 1);
          delim += src.slice(k + 1, j < 0 ? src.length : j);
          k = j < 0 ? src.length : j + 1;
        } else if (src[k] === "\\") {
          delim += src[k + 1] ?? "";
          k += 2;
        } else delim += src[k++];
      }
      pending.push({ delim, strip, cmd });
      i = k;
    } else if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      if (inTok && /^\d+$/.test(tok)) {
        tok = "";
        inTok = false;
      } else endTok();
      let k = i + 1;
      if (c === "<" && src[k] === "<") k++; // <<< here-string: its word is data
      if (src[k] === ">" || src[k] === "|") k++;
      if (src[k] === "&") {
        k++;
        while (/[\d-]/.test(src[k] ?? "")) k++;
        i = k;
        continue;
      }
      redirectNext = true;
      i = k;
    } else if (c === "\n") {
      endCmd();
      i++;
      for (const h of pending) {
        const lines: string[] = [];
        while (i < src.length) {
          const j = src.indexOf("\n", i);
          const line = src.slice(i, j < 0 ? src.length : j);
          i = j < 0 ? src.length : j + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.cmd.heredocs.push(lines.join("\n"));
      }
      pending.length = 0;
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      const ended = cmd;
      endCmd();
      i++;
      if ((c === "&" || c === "|") && src[i] === c) i++;
      else if (c === "|") cmd.from = ended;
    } else if (c === " " || c === "\t") {
      endTok();
      i++;
    } else {
      tok += c;
      inTok = true;
      i++;
    }
  }
  endCmd();
  return out;
}

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "nice",
  "time",
  "timeout",
  "gtimeout",
  "caffeinate",
  "stdbuf",
  "ionice",
  "xargs",
  "unbuffer",
]);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "elif", "else", "do", "while", "until"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Wrapper options whose value is the next word.
const TIMEOUT_OPTIONS = /^(?:-[sk]|--(?:signal|kill-after))$/;
const VALUE_OPTIONS: Record<string, RegExp> = {
  sudo: /^(?:-[ugCDhpRrTt]|--(?:user|group|close-from|chdir|host|prompt|role|type|command-timeout))$/,
  doas: /^-[uC]$/,
  xargs: /^(?:-[IJLPnsdEa]|--(?:arg-file|delimiter|max-args|max-procs|max-chars|process-slot-var))$/,
  nice: /^(?:-n|--adjustment)$/,
  ionice: /^(?:-[cnpPu]|--(?:class|classdata|pid|pgid|uid))$/,
  env: /^(?:-[uSCP]|--(?:unset|chdir|split-string))$/,
  stdbuf: /^(?:-[ioe]|--(?:input|output|error))$/,
  timeout: TIMEOUT_OPTIONS,
  gtimeout: TIMEOUT_OPTIONS,
};
// Wrapper options that run the program in another folder, clustered or not.
const CHDIR_OPTIONS: Record<string, RegExp> = {
  env: /^(?:-[A-Za-z]*C|--chdir)/,
  sudo: /^(?:-[A-Za-z]*D|--chdir)/,
};

/**
 * Whether a wrapper's cluster of short options, such as env -iC or xargs -tn,
 * takes the next word as a value: its first option that takes one comes last.
 * One earlier, as in sudo -uroot, takes the rest of the cluster.
 */
function clusterTakesNext(w: string, opt: string): boolean {
  if (!/^-[A-Za-z0-9]{2,}$/.test(opt)) return false;
  return [...opt.slice(1)].findIndex((c) => VALUE_OPTIONS[w]?.test(`-${c}`)) === opt.length - 2;
}

/** Strips leading assignments, keywords, a function's header and wrappers such as sudo or xargs. */
function unwrap(argv: string[]): { argv: string[]; wrappers: string[]; chdir: boolean } {
  const a = argv.slice();
  const wrappers: string[] = [];
  let chdir = false;
  for (;;) {
    // function f { … } is stripped to its body, which runs when f is called.
    while (a.length && (ASSIGNMENT.test(a[0]) || KEYWORDS.has(a[0]) || a[0] === "function"))
      a.splice(0, a[0] === "function" ? 2 : 1);
    if (!a.length || !WRAPPERS.has(base(a[0]))) return { argv: a, wrappers, chdir };
    const w = base(a.shift() as string);
    wrappers.push(w);
    while (
      a.length &&
      (a[0].startsWith("-") || ASSIGNMENT.test(a[0]) || (w.endsWith("timeout") && /^\d/.test(a[0])))
    ) {
      const opt = a.shift() as string;
      if (CHDIR_OPTIONS[w]?.test(opt)) chdir = true;
      if (VALUE_OPTIONS[w]?.test(opt) || clusterTakesNext(w, opt)) a.shift();
    }
  }
}

/** The program a simple command's words run, with what unwrap strips taken off. */
export function programOf(words: string[]): {
  argv: string[];
  name: string;
  wrappers: string[];
  chdir: boolean;
} {
  const { argv, wrappers, chdir } = unwrap(words);
  return { argv, name: argv.length ? base(argv[0]) : "", wrappers, chdir };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Interpreters whose code this splitter can't split. A version (python3.12) and
// a runner in front (uv run python, npx tsx) don't hide one.
const INTERPRETER = /^(?:python|pypy|node|ruby|perl|php|osascript|deno|bun|tsx|ts-node)[\d.]*$/;
// Interpreter flags whose next word is code, alone or ending a cluster (python
// -uc): python -c, node -e and -p, perl -e and -E, ruby -e, php -r, osascript -e.
const CODE_FLAG = /^(?:-[A-Za-z]*[ceEpr]|--eval|--print)$/;

/** What reaches a command's stdin that can be read here: its here-documents, and what echo, printf or a here-document pipes in. */
function stdin(raw: Raw): string[] {
  if (!raw.from) return raw.heredocs;
  const { argv, name } = programOf(raw.from.words);
  let k = 1;
  if (name === "echo") while (/^-[neE]+$/.test(argv[k] ?? "")) k++;
  const printed = name === "echo" || name === "printf" ? [argv.slice(k).join(" ")] : [];
  return [...raw.heredocs, ...raw.from.heredocs, ...printed];
}

/** The code an interpreter among the words runs: a code flag's word after it, deno eval's words, and its stdin. */
function codeOf(argv: string[], raw: Raw): string[] {
  const at = argv.findIndex((t) => INTERPRETER.test(base(t)));
  if (at < 0) return [];
  // A flag before the interpreter is a runner's, such as docker run -e.
  const args = argv.slice(at + 1);
  const code = args[0] === "eval" ? args.slice(1) : [];
  args.forEach((t, k) => {
    const attached = /^--(?:eval|print)=([\s\S]*)$/.exec(t);
    if (attached) code.push(attached[1]);
    else if (CODE_FLAG.test(t) && args[k + 1] !== undefined) code.push(args[k + 1]);
  });
  return [...code, ...stdin(raw)];
}

/**
 * Every simple command in a line, including those run by bash -c, eval, and
 * a shell's here-document or what is piped into it.
 */
export function commandsOf(line: string, depth = 0): Cmd[] {
  const out: Cmd[] = [];
  for (const raw of splitShell(line)) {
    const { argv, name, wrappers, chdir } = programOf(raw.words);
    const code = codeOf(argv, raw);
    out.push({
      words: raw.words,
      argv,
      name,
      wrappers,
      chdir,
      redirects: raw.redirects,
      heredocs: raw.heredocs,
      code,
    });
    if (depth >= 8) continue;
    if (SHELLS.has(name)) {
      const flag = argv.findIndex((t, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
      if (flag > 0 && argv[flag + 1] !== undefined) out.push(...commandsOf(argv[flag + 1], depth + 1));
      for (const body of stdin(raw)) out.push(...commandsOf(body, depth + 1));
    } else if (name === "eval") {
      out.push(...commandsOf(argv.slice(1).join(" "), depth + 1));
    }
  }
  return out;
}

const BRACE_LIMIT = 64;
// A group with a comma; [^{},]* matches at the first comma, so an unclosed group costs linear time.
const BRACE_GROUP = /\{([^{},]*,[^{}]*)\}/;

/**
 * A word with its first 64 brace expansions, as the shell expands them: {a,b}/x
 * gives a/x and b/x. Quoted JSON reaches here as one word, with a group for
 * every object, so it stops at the limit as it goes, and expands at most 64
 * groups on the way to each.
 */
function expandBraces(word: string, out: string[] = [], depth = 0): string[] {
  if (out.length >= BRACE_LIMIT) return out;
  const m = depth < BRACE_LIMIT ? BRACE_GROUP.exec(word) : null;
  if (!m) {
    out.push(word);
    return out;
  }
  const [before, after] = [word.slice(0, m.index), word.slice(m.index + m[0].length)];
  for (const alt of m[1].split(",")) expandBraces(before + alt + after, out, depth + 1);
  return out;
}

/** The parts of a shell word that could be paths: split at = (--opt=path) and, outside URLs, at : (rev:path). */
function pathsIn(word: string): string[] {
  return expandBraces(word)
    .flatMap((w) => w.split("="))
    .flatMap((part) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(part) ? [part] : part.split(":")))
    .filter(Boolean);
}

/** Every word of a command that could be a path. An interpreter's code can't be split, so its words count too. */
const wordsOf = (c: Cmd) => [
  ...c.words,
  ...c.redirects,
  ...c.code.flatMap((body) => body.split(/[\s'"`(),;]+/)),
];

/**
 * What a command line names that could be a path, each part once, and the
 * folders it moves to with cd, pushd or git -C, as written.
 */
export function pathsOf(line: string): { parts: string[]; dirs: string[] } {
  const commands = commandsOf(line);
  const dirs: string[] = [];
  for (const { argv, name } of commands) {
    const flag = name === "git" ? argv.indexOf("-C") : -1;
    const to = name === "cd" || name === "pushd" ? argv[1] : flag > 0 ? argv[flag + 1] : undefined;
    if (to && !to.startsWith("-")) dirs.push(to);
  }
  // Each part once: a JSON body's brace expansions repeat most of theirs.
  return { parts: [...new Set(commands.flatMap(wordsOf).flatMap(pathsIn))], dirs };
}
