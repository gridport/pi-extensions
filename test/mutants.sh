#!/bin/bash
# Breaks the code one way at a time and runs the fast tests on each broken copy,
# in a temp directory, which also holds the tests' fixtures, so whatever a
# killed test process leaves goes with it. Every mutant must make a test fail;
# a survivor is a behaviour no test pins. An entry's text matches with any run
# of whitespace standing for any other, so reformatting doesn't move it; an
# entry whose text is not in its file exactly once is reported as broken:
# update it with the code.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions-mutants.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$repo/package.json" "$work/"
ln -s "$repo/node_modules" "$work/node_modules"
bad=0

mutant() { # file name from to
	rm -rf "$work/extensions" "$work/src" "$work/test" "$work/fixtures"
	cp -R "$repo/extensions" "$repo/src" "$repo/test" "$work/"
	mkdir "$work/fixtures"
	if ! perl -e '
		my ($f, $from, $to) = @ARGV;
		local $/; open my $h, "<", $f or die; my $s = <$h>; close $h;
		my $re = join q{\s+}, map { quotemeta } split /\s+/, $from, -1;
		my $n = () = $s =~ /$re/g;
		exit 3 if $n != 1;
		$s =~ s/$re/$to/;
		open $h, ">", $f or die; print $h $s; close $h' "$work/$1" "$3" "$4"; then
		echo "BROKEN   $1: $2: its text is not in the file exactly once"
		bad=1
		return
	fi
	out=$(cd "$work" && GUARD_TEST_FIXTURES="$work/fixtures" node --test test/*.test.ts 2>&1)
	rc=$?
	failed=$(printf '%s\n' "$out" | grep -E '^✖ ' | grep -v 'failing tests' | sed 's/ ([0-9.]*ms)$//' | sort -u | tr '\n' ';')
	if [ $rc -eq 1 ] && [ -n "$failed" ]; then
		echo "killed   $1: $2 :: $failed"
	else
		echo "SURVIVED $1: $2 (exit $rc)"
		bad=1
	fi
}

f=src/shell.ts
mutant $f "cd and git -C targets are not dirs" 'if (to && !to.startsWith("-")) dirs.push(to);' ''
mutant $f "pushd is not a cd" 'name === "cd" || name === "pushd"' 'name === "cd"'
mutant $f "git -C is not a dir" 'flag > 0 ? argv[flag + 1] : undefined' 'undefined'
mutant $f "braces are not expanded" 'return expandBraces(word)' 'return [word]'
# Not removed outright: with no limit at all, the test runs out of memory instead.
mutant $f "the brace limit is far too high" 'if (out.length >= BRACE_LIMIT) return out;' 'if (out.length >= BRACE_LIMIT ** 3) return out;'
mutant $f "the limit keeps one expansion" 'const BRACE_LIMIT = 64;' 'const BRACE_LIMIT = 1;'
mutant $f "every brace group is expanded" 'depth < BRACE_LIMIT ? BRACE_GROUP.exec(word) : null' 'BRACE_GROUP.exec(word)'
mutant $f "an unclosed group costs quadratic time" '/\{([^{},]*,[^{}]*)\}/' '/\{([^{}]*,[^{}]*)\}/'
mutant $f "redirections are not paths" '...c.words, ...c.redirects, ...c.code' '...c.words, ...c.code'
mutant $f "an interpreter's code is not paths" '...c.redirects, ...c.code.flatMap(' '...c.redirects, ...[].flatMap('
mutant $f "each part is listed for every expansion" 'parts: [...new Set(commands.flatMap(wordsOf).flatMap(pathsIn))]' 'parts: commands.flatMap(wordsOf).flatMap(pathsIn)'
mutant $f "--opt=path is not split" '.split("=")' '.split("\u0000")'
mutant $f "rev:path is not split" ': part.split(":"))' ': [part])'
mutant $f "a here-document's body is read as commands" 'pending.push({ delim, strip, cmd });' ''
mutant $f "substitutions are not looked into" 'if (depth < 8) out.push(...splitShell(text, depth + 1));' ''
mutant $f "a wrapper's option values stay" 'if (VALUE_OPTIONS[w]?.test(opt)) a.shift();' ''
mutant $f "ionice -c takes no value" 'ionice: /^(?:-[cnpPu]|' 'ionice: /^(?:-[npPu]|'
mutant $f "stdbuf -o takes no value" 'stdbuf: /^(?:-[ioe]|' 'stdbuf: /^(?:-[ie]|'
mutant $f "doas -u takes no value" 'doas: /^-[uC]$/' 'doas: /^-[C]$/'
mutant $f "sudo --user takes no value" '--(?:user|group' '--(?:group'
mutant $f "xargs --max-args takes no value" '|max-args|' '|'
mutant $f "timeout --signal takes no value" '--(?:signal|kill-after)' '--(?:kill-after)'
mutant $f "a function's body is not looked into" ' || a[0] === "function"' ''
mutant $f "a function's name is taken for its program" 'a[0] === "function" ? 2 : 1' 'a[0] === "function" ? 1 : 1'
mutant $f "redirection targets count as arguments" 'redirectNext = true;' ''
mutant $f "a comment is read as a command" '} else if (c === "#" && !inTok) {' '} else if (false) {'
mutant $f "eval is not looked into" 'out.push(...commandsOf(argv.slice(1).join(" "), depth + 1));' ''
mutant $f "bash -c is not looked into" 'if (flag > 0 && argv[flag + 1] !== undefined) out.push(...commandsOf(argv[flag + 1], depth + 1));' ''
mutant $f "a shell's here-document is not looked into" 'for (const body of stdin(raw)) out.push(...commandsOf(body, depth + 1));' ''
mutant $f "a shell's piped input is not looked into" 'for (const body of stdin(raw)) out.push' 'for (const body of raw.heredocs) out.push'
mutant $f "quotes are kept in the word" 'tok += src.slice(i + 1, end);' 'tok += src.slice(i, end + 1);'
mutant $f "keywords are not stripped" '|| KEYWORDS.has(a[0])' ''
mutant $f "a pipe doesn't link commands" 'else if (c === "|") cmd.from = ended;' ''
mutant $f "|| counts as a pipe" 'else if (c === "|") cmd.from = ended;' 'if (c === "|") cmd.from = ended;'
mutant $f "a piped here-document is not read" '...raw.from.heredocs, ...printed' '...printed'
mutant $f "what echo prints is not piped" 'name === "echo" || name === "printf" ?' 'name === "printf" ?'
mutant $f "what printf prints is not piped" 'name === "echo" || name === "printf" ?' 'name === "echo" ?'
mutant $f "echo's flags are piped" 'if (name === "echo") while (/^-[neE]+$/.test(argv[k] ?? "")) k++;' ''
mutant $f "an interpreter's stdin is not code" 'return [...code, ...stdin(raw)];' 'return code;'
mutant $f "an interpreter's -c code is not read" 'else if (CODE_FLAG.test(t) && args[k + 1] !== undefined) code.push(args[k + 1]);' ''
mutant $f "a code flag ending a cluster is missed" '-[A-Za-z]*[ceEpr]' '-[ceEpr]'
mutant $f "--eval is not code" '|--eval|' '|'
mutant $f "--eval= is not code" 'if (attached) code.push(attached[1]);' 'if (false) code.push(attached[1]);'
mutant $f "deno eval is not code" 'const code = args[0] === "eval" ? args.slice(1) : [];' 'const code: string[] = [];'
mutant $f "a flag before the interpreter counts" 'const args = argv.slice(at + 1);' 'const args = argv.slice(1);'
mutant $f "a versioned interpreter is missed" ')[\d.]*$/' ')$/'
mutant $f "an interpreter behind a runner is missed" 'argv.findIndex((t) => INTERPRETER.test(base(t)))' '(INTERPRETER.test(base(argv[0] ?? "")) ? 0 : -1)'

f=src/paths.ts
mutant $f "a missing path is not resolved through its parent" 'return parent === p ? p : join(realOrSame(parent), basename(p));' 'return p;'

f=src/settings.ts
mutant $f "~ in PI_CODING_AGENT_DIR is not expanded" '= () => expandHome(process.env.PI_CODING_AGENT_DIR' '= () => (process.env.PI_CODING_AGENT_DIR'
mutant $f "a project's list replaces the global one" '[...(isList(g[key]) ? g[key] : fallback), ...(isList(m[key]) ? m[key] : [])]' '[...(isList(m[key]) ? m[key] : isList(g[key]) ? g[key] : fallback)]'
mutant $f "a project can't add" ', ...(isList(m[key]) ? m[key] : [])' ''
mutant $f "a bad global list counts as empty" 'isList(g[key]) ? g[key] : fallback' 'isList(g[key]) ? g[key] : []'
mutant $f "an entry can show twice" '...new Set([...(isList(g[key])' '...([...(isList(g[key])'
mutant $f "a project sets what only the global settings may" 'globalOnly: (key: string): unknown => g[key]' 'globalOnly: (key: string): unknown => m[key] ?? g[key]'

f=src/subagents.ts
mutant $f "nothing is registered" 'session.registration = registerRequiredChildExtensions({ sessionId, extensions });' ''
mutant $f "the old registration is not disposed" 'session.registration?.dispose();' ''
mutant $f "leaving keeps the guard registered" 'if (!session.members.delete(id)) return;' 'if (!session.members.has(id)) return;'
mutant $f "a guard that couldn't join is kept" 'session.members.delete(id); if (!session.members.size) all.delete(sessionId); throw err;' 'throw err;'

f=extensions/loop.ts
mutant $f "no Math.max on checked" 'job.checked = Math.max(job.checked, slot);' 'job.checked = slot;'
mutant $f "restore from the session_start minute" 'checked: j.checked ?? minuteOf(now), due: j.due' 'checked: minuteOf(now)'
mutant $f "no save on reload shutdown" 'if (event.reason === "reload" && jobs.length) save();' ''
mutant $f "no hold after Esc" 'holdUntil = Date.now() + HOLD_AFTER_ESC_MS;' ''
mutant $f "no pending-message guard" ' || ctx.hasPendingMessages()' ''
mutant $f "newest firing first" '(a.due ?? 0) - (b.due ?? 0)' '(b.due ?? 0) - (a.due ?? 0)'
mutant $f "a new job checks its own minute" 'expiresAt, checked: minuteOf(now),' 'expiresAt, checked: minuteOf(now) - MINUTE,'
mutant $f "only a bare * stars a day field" 'anyDom: parts[2].startsWith("*")' 'anyDom: parts[2] === "*"'
mutant $f "duplicate prompts allowed" 'if (twin) throw' 'if (false && twin) throw'
mutant $f "a one-shot is kept" 'if (!job.recurring) {' 'if (false) {'
mutant $f "no save after the lapse warning" '} else if (saved.length) { save();' '} else if (saved.length) {'
mutant $f "/loop delete without an id falls through" 'if (!id) throw new Error("usage: /loop delete <id|all>");' ''
mutant $f "7 is not Sunday" 'if (dow.has(7)) dow.add(0);' ''
mutant $f "no expiry" 'const expired = jobs.filter((j) => now >= j.expiresAt);' 'const expired = jobs.filter((j) => false);'
mutant $f "either day field when one is starred" 'return c.anyDom || c.anyDow ? dom && dow : dom || dow;' 'return dom || dow;'
mutant $f "the created minute itself can match" 'for (let t = minuteOf(after) + MINUTE; t <= until; t += MINUTE) {' 'for (let t = minuteOf(after); t <= until; t += MINUTE) {'

f=extensions/command-guard.ts
mutant $f "rm -R is not recursive" '/^-[A-Za-z]*[rR][A-Za-z]*$/' '/^-[A-Za-z]*r[A-Za-z]*$/'
mutant $f "rm --recursive is not recursive" 't === "--recursive" || ' ''
mutant $f "sudo is not noticed" 'asRoot.some((w) => w === "sudo" || w === "doas")' 'false'
mutant $f "find -exec sudo is not noticed" ', ...runs.map((r) => r.wrappers)' ''
mutant $f "find -delete is not noticed" 'argv.includes("-delete") || ' ''
mutant $f "find -exec rm is not noticed" 'runs.some((r) => r.name === "rm")' 'false'
mutant $f "an -exec runs to the + alone" 'k > i && (t === ";" || t === "+")' 'k > i && t === "+"'
mutant $f "a temp root counts as inside" 'TEMP_ROOTS.some((root) => p.startsWith(`${root}/`))' 'TEMP_ROOTS.some((root) => p.startsWith(root))'
mutant $f "a variable target counts as temp" 'if (/[$`{]/.test(t)) return false;' 'if (/[`{]/.test(t)) return false;'
mutant $f "a brace expansion counts as temp" 'if (/[$`{]/.test(t)) return false;' 'if (/[$`]/.test(t)) return false;'
mutant $f ".. after a glob counts as temp" 'if (glob >= 0 && t.slice(glob).split("/").includes("..")) return false;' ''
mutant $f "a cd keeps relative targets exempt" '(!isAbsolute(stem) && changesDir)' '(false)'
mutant $f "symlinks are not followed" 'if (underTemp(abs) && underTemp(real)) return true;' 'if (underTemp(abs)) return true;'
mutant $f "allowed folders are ignored" 'return inNamed(abs, resolve(cwd), folders) &&' 'return false &&'
mutant $f "a symlink out of an allowed folder counts" ' && inNamed(real, realOrSame(resolve(cwd)), folders)' ''
mutant $f "a folder whose name starts the session's counts" 'p.startsWith(`${root}/`) &&' ''
mutant $f "the session's own folders count" '.slice(root.length + 1)' ''
mutant $f "a project allows folders" 'settings.globalOnly("allowFolders")' 'settings.projectAdds("allowFolders", [], isList)'
mutant $f "a path counts as a folder name" ' && !f.includes("/")' ''
mutant $f "a .. entry counts as a folder name" ' && f !== ".."' ''
mutant $f "a variable target gets no warning" 'const variable = left.find((t) => /[$`]/.test(t));' 'const variable = undefined;'
mutant $f "a glob target gets no warning" 'const glob = left.find((t) => /[*?[]/.test(t));' 'const glob = undefined;'
mutant $f "a warning may name an exempt target" 'const left = targets.filter((t) => !exempt(t, cwd, changesDir, cfg.allowFolders));' 'const left = targets.filter((t) => !exempt(t, cwd, changesDir, []));'
mutant $f "a short flag does not match inside a cluster" ' && tok.includes(spec[1])' ' && tok === spec'
mutant $f "a rule ignores its args" 'return !rule.args ||' 'return true ||'
mutant $f "a project sets the timeout" 'const t = settings.globalOnly("timeoutSeconds");' 'const t = (merged as Record<string, unknown>)?.timeoutSeconds ?? settings.globalOnly("timeoutSeconds");'
mutant $f "builtins are global only" 'settings.projectAdds<unknown>("builtins", DEFAULTS.builtins, isList)' '[settings.globalOnly("builtins") ?? DEFAULTS.builtins].flat()'
mutant $f "asks with no UI" 'if (!ctx.hasUI) {' 'if (false) {'
mutant $f "a 5-minute timeout" '{ timeout: ms, signal' '{ timeout: 300_000, signal'
mutant $f "subagents don't load it" 'subagents = await joinSubagents(ctx.sessionManager.getSessionId(), "command-guard", path);' ''
mutant $f "it stays registered after shutdown" 'pi.on("session_shutdown", () => { subagents?.leave();' 'pi.on("session_shutdown", () => {'

f=extensions/secret-guard.ts
mutant $f "folder names are case-sensitive" 'if (!names.has(parts[i].toLowerCase())) continue;' 'if (!names.has(parts[i])) continue;'
mutant $f "the folder itself counts without existing" 'existing?.(parts.slice(0, i + 1).join("/"))' 'existing'
mutant $f "a path into one needs the folder to exist" 'if (i < parts.length - 1 || existing?.(' 'if (existing?.('
mutant $f "a folder's name alone is dropped" 'if (i < parts.length - 1 || existing?.(' 'if (true || existing?.('
mutant $f "a file counts as a folder" 'return statSync(p).isDirectory();' 'return !!statSync(p);'
mutant $f "symlinks are not followed" ' ?? folderIn(realOrSame(abs), folders, isDir)' ''
mutant $f "the folders a line moves to are not bases" ', ...paths.dirs.map((dir) => resolve(cwd, expandHome(dir)))' ''
mutant $f "a cd target's ~ is not expanded" 'resolve(cwd, expandHome(dir))' 'resolve(cwd, dir)'
mutant $f "web URLs count as paths" ' && !/^file:\/\//i.test(raw)) return undefined;' ' && false) return undefined;'
mutant $f "prose tools are checked as paths" 'else if (!PROSE_TOOLS.has(name))' 'else if (true)'
mutant $f "other tools' arguments are not checked" 'hit = argHit(input, ctx.cwd, cfg.folders);' 'hit = undefined;'
mutant $f "the mark can be written into a secret file" 'isSecretFile(path, cfg) && JSON.stringify(input).includes(MARK)' 'false'
mutant $f "the mark can be written by bash" 'if (name === "bash" && writesMark(' 'if (false && writesMark('
mutant $f "the mark can't be written anywhere" 'isSecretFile(path, cfg) && JSON.stringify(input)' 'JSON.stringify(input)'
mutant $f "short key names match inside words" '(key.length >= 5 && upper.includes(key))' 'upper.includes(key)'
mutant $f "the mark precheck is gone" 'if (!command.includes(MARK)) return false;' ''
mutant $f "URL passwords are kept" 'if (line[to] === "@" && to > from) {' 'if (false) {'
mutant $f "a URL needs a user" '[^\s:/@]*:/gi' '[^\s:/@]+:/gi'
mutant $f "a / ends a URL password" 'const URL_PASSWORD = /[^\s@]*/y;' 'const URL_PASSWORD = /[^\s@/]*/y;'
mutant $f "a long URL password is kept" 'const URL_PASSWORD = /[^\s@]*/y;' 'const URL_PASSWORD = /[^\s@]{0,256}/y;'
mutant $f "an empty URL password is redacted" ' && to > from' ''
mutant $f "a password with no @ is scanned again from each URL in it" 'URL_USER.lastIndex = to;' ''
mutant $f "a CRLF line loses its \r" 'const cr = line.endsWith("\r") ? "\r" : "";' 'const cr = "";'
mutant $f "a \r inside a value hides it" '(\s*=\s*|\s*:\s+)([^\n]*)$/;' '(\s*=\s*|\s*:\s+)(.*)$/;'
mutant $f "a key block opened on a CRLF line keeps the rest" '[^\\n]*?(?=\\r?$)' '.*$'
mutant $f "a key block opened on a CRLF line loses its \r" '[^\\n]*?(?=\\r?$)' '[^\\n]*'
mutant $f "line numbers hide the name" '(?:\d+[:\t-]\s*)*' ''
mutant $f "a second line number hides the name" '(?:\d+[:\t-]\s*)*' '(?:\d+[:\t-]\s*)?'
mutant $f "declare lines are not parsed" '(?:export|declare|typeset)' '(?:export)'
mutant $f "private-key blocks are kept" 'if (PEM_BEGIN.test(line) && !PEM_END.test(line)) {' 'if (false) {'
mutant $f "PGP key blocks are kept" 'PRIVATE KEY(?: BLOCK)?' 'PRIVATE KEY'
mutant $f "env output is not redacted" '(!argv.length && wrappers.includes("env")) ||' ''
mutant $f "printenv output is not redacted" '|| name === "printenv";' ';'
mutant $f "printenv NAME is not redacted" 'if (name === "printenv" && args.some((a) => secretName(a, cfg.redactKeys))) return "values";' ''
mutant $f "declare listings are not redacted" 'args.every((a) => a.startsWith("-"))' 'false'
mutant $f "set alone lists nothing" 'name === "set" ? !args.length' 'name === "set" ? false'
mutant $f "set with options lists the variables" '? !args.length' '? args.every((a) => a.startsWith("-"))'
mutant $f "declare -p NAME is not redacted" '|| (["declare", "typeset"].includes(name) && args.some((a) => /^-[A-Za-z]*p/.test(a)))' ''
mutant $f "a glob never names a secret file" 'if (!/[*?]/.test(name)) return isSecretFile(word, cfg);' 'return isSecretFile(word, cfg);'
mutant $f "a redirect never names a secret file" '[...words, ...redirects].some((t) => namesSecretFile(t, cwd, cfg))' 'words.some((t) => namesSecretFile(t, cwd, cfg))'
mutant $f "a context line from a secret file is missed" 'if (line[i] !== ":" && line[i] !== "-") continue;' 'if (line[i] !== ":") continue;'
mutant $f "bash output is not filtered" 'text = (t) => redact(output(cut.text)(t), cut.text);' 'text = (t) => redact(t, cut.text);'
mutant $f "grep and find output is not filtered" '"find") { text = output({});' '"find") { text = undefined;'
mutant $f "pi's bash log is not filtered" 'if (isBashLog(path)) { const cut' 'if (false) { const cut'
mutant $f "a project's redactFiles skips the log's filtering" 'if (isBashLog(path)) { const cut' 'if (isBashLog(path) && !isSecretFile(path, cfg)) { const cut'
mutant $f "a command naming pi's log is not redacted" 'pathsOf(command).parts.some(isBashLog)' 'false'
mutant $f "a read of pi's bash log is not redacted" 'text = (t) => redactText(output(cut)(t), cfg.redactKeys, keyOpen(cut));' 'text = output(cut);'
mutant $f "a log read from inside a key shows it" 'redactText(output(cut)(t), cfg.redactKeys, keyOpen(cut))' 'redactText(output(cut)(t), cfg.redactKeys)'
mutant $f "a log read from an offset starts outside its section" 'const cut = cutOf(leftOut(event, ctx.cwd).text, cfg);' 'const cut = {};'
mutant $f "cut-off text resumes outside a protected section" 'inSection: endsInSection(head, opens),' 'inSection: false,'
mutant $f "cut-off text resumes outside a secret section" 'inSecret: endsInSection(head, opensSecret),' 'inSecret: false,'
mutant $f "cut-off text resumes outside a key" 'inKey: endsInKey(head),' 'inKey: false,'
mutant $f "a key in a protected section is dropped on past it" '!!cut.inKey && !cut.inSection && !cut.inSecret' '!!cut.inKey && !cut.inSecret'
mutant $f "a key in a secret section is dropped on past it" '!!cut.inKey && !cut.inSection && !cut.inSecret' '!!cut.inKey && !cut.inSection'
mutant $f "a block never closes" 'inKey = !PEM_END.test(line);' 'inKey = true;'
mutant $f "matches from secret files are not redacted" 'if (isSecretFile(path, cfg)) return line.slice(0, i + 1)' 'if (false) return line.slice(0, i + 1)'
mutant $f "matches from pi's log are not redacted" 'if (isBashLog(path)) { // The log' 'if (false) { // The log'
mutant $f "a log's line is not looked at again" 'depth < 8 ? redactMatch(inner, cfg, depth + 1) : inner' 'inner'
mutant $f "a log's line number is not skipped" 'const number = /^\d+[:-] ?/.exec(rest)?.[0] ?? "";' 'const number = "";'
mutant $f "a log's context line number is not skipped" '/^\d+[:-] ?/' '/^\d+: ?/'
mutant $f "the space after a log's line number is kept" '/^\d+[:-] ?/' '/^\d+[:-]/'
mutant $f "nested logs are looked into without end" 'depth < 8 ?' 'true ?'
mutant $f "reading a secret file is not redacted" 'text = (t) => redactText(t, cfg.redactKeys, inKey);' 'text = (t) => t;'
mutant $f "a read of a secret file from inside a key shows it" 'redactText(t, cfg.redactKeys, inKey)' 'redactText(t, cfg.redactKeys)'
mutant $f "bash output from inside a key shows it" 'redactText(kept, cfg.redactKeys, keyOpen(from))' 'redactText(kept, cfg.redactKeys)'
mutant $f "codemode's copy starts where the tail does" 'redact(output(cut.structured)(t), cut.structured)' 'redact(output(cut.structured)(t), cut.text)'
mutant $f "codemode's copy is filtered like the tail" 'return text && patchResult(event, text, structured);' 'return text && patchResult(event, text);'
mutant $f "an omission resumes outside a section" 'inSection: middle.some(opens)' 'inSection: false'
mutant $f "an omission resumes outside a secret section" 'inSecret: middle.some(opensSecret)' 'inSecret: false'
mutant $f "the omission marker is not seen" 'if (isOmission(line)) { kept.push(line);' 'if (false) { kept.push(line);'
mutant $f "a partial line after an omission sets the section" 'inSection = cut.afterOmission?.inSection ?? inSection; partial = true;' 'inSection = cut.afterOmission?.inSection ?? inSection;'
mutant $f "the omission marker is not seen in a secret section" 'next = cut.afterOmission?.inSecret ?? inSecret;' 'next = inSecret;'
mutant $f "a partial line after an omission sets the secret section" 'next = cut.afterOmission?.inSecret ?? inSecret; partial = true;' 'next = cut.afterOmission?.inSecret ?? inSecret;'
mutant $f "the line after an omission is kept" 'out.push(MARK); partial = false;' 'out.push(redactLine(line, keys)); partial = false;'
mutant $f "the grep tool can read a guarded log" 'name === "grep" ? [path]' 'name === "grep" ? []'
mutant $f "bash can read a guarded log" '(paths?.parts ?? [])' '[]'
mutant $f "every log is guarded" 'linesOf(p, cwd).some((line) => opensSection(line, folders))' 'true'
mutant $f "any file counts as a log" 'isBashLog(p) &&' ''
mutant $f "a git diff section is kept" 'headerPaths(line).some((w) => folderIn(w, folders) !== undefined)' 'false'
mutant $f "a quoted header path keeps its quotes" '.map((w) => w.replace(/^"|"$/g, ""))' ''
mutant $f "a short hex prefix ends a section" '[0-9a-f]{7,40}\b' '[0-9a-f]{1,40}'
mutant $f "a merge diff is no section" 'diff --(?:git|cc|combined)' 'diff --(?:git)'
mutant $f "a commit line doesn't end a section" 'return COMMIT_LINE.test(line) ? false : inSection;' 'return inSection;'
mutant $f "a diff's marker hides the name" '(?:[-+<>!]+\s*)?' ''
mutant $f "a normal diff's < and > hide the name" '(?:[-+<>!]+\s*)?' '(?:[-+!]+\s*)?'
mutant $f "diff -c's ! hides the name" '(?:[-+<>!]+\s*)?' '(?:[-+<>]+\s*)?'
mutant $f "a merge diff's two markers hide the name" '(?:[-+<>!]+\s*)?' '(?:[-+<>!]\s*)?'
mutant $f "a secret file's diff section is not seen" 'headerPaths(line).some((w) => isSecretFile(w, cfg))' 'false'
mutant $f "a secret file's diff section is kept" 'for (const line of redactKeys(section, cfg.redactKeys, inKey)) out.push(line);' 'for (const line of section) out.push(line);'
mutant $f "a long secret section is spread into push" 'for (const line of redactKeys(section, cfg.redactKeys, inKey)) out.push(line);' 'out.push(...redactKeys(section, cfg.redactKeys, inKey));'
mutant $f "each END with no BEGIN drops back to the start" 'out.fill(undefined, from).push(undefined); from = out.length;' 'out.fill(undefined, from).push(undefined);'
mutant $f "a cut-off secret section is not redacted" 'let inSecret = cut.inSecret ?? false;' 'let inSecret = false;'
mutant $f "a cut-off secret section starts outside a key" 'let inKey = inSecret && (cut.inKey ?? false);' 'let inKey = false;'
mutant $f "a hunk header keeps its context in a secret section" 'section.push(HUNK.exec(line)?.[0] ?? line);' 'section.push(line);'
mutant $f "a merge's @@@ keeps its context" 'const HUNK = /^@@+ [^@]*@@+/;' 'const HUNK = /^@@ [^@]*@@/;'
mutant $f "a new section goes on inside the last one's key" 'if (DIFF_HEADER.test(line) || next !== inSecret) flush();' 'if (next !== inSecret) flush();'
mutant $f "a hunk doesn't end a key" '[inKey, from, partial] = [false, out.length, isOmission(line)];' '[from, partial] = [out.length, isOmission(line)];'
mutant $f "an END with no BEGIN drops from the start" '[inKey, from, partial] = [false, out.length, isOmission(line)];' '[inKey, partial] = [false, isOmission(line)];'
mutant $f "an END with no BEGIN is kept" 'out.fill(undefined, from).push(undefined);' 'out.push(redactLine(line, keys));'
mutant $f "a hunk's context line is kept" '(?:@@+ [^@]*@@+ ?)?' ''
mutant $f "a merge's @@@ is no hunk" '(?:@@+ [^@]*@@+ ?)?' '(?:@@ [^@]*@@ ?)?'
mutant $f "a line of @ costs quadratic time" '(?:@@+ [^@]*@@+ ?)?' '(?:@@+[^@]*@@+ ?)?'
mutant $f "a command's words are expanded without its naming pi's log" 'command.includes("pi-bash-") &&' ''
mutant $f "a --oneline commit doesn't end a section" '(?:commit )?[0-9a-f]' 'commit [0-9a-f]'
mutant $f "subagents don't load it" 'subagents = await joinSubagents(ctx.sessionManager.getSessionId(), "secret-guard", path);' ''
mutant $f "it stays registered after shutdown" 'pi.on("session_shutdown", () => { subagents?.leave();' 'pi.on("session_shutdown", () => {'
mutant $f "a list of non-strings counts" 'v.every((s) => typeof s === "string")' 'true'

f=src/pi-output.ts
mutant $f "any .log is pi's" 'const BASH_LOG = /^pi-bash-[0-9a-f]+\.log$/;' 'const BASH_LOG = /\.log$/;'
mutant $f "any bracketed line is an omission" '/^\[\.\.\. \d+ bytes omitted \.\.\.\]$/' '/^\[.*\]$/'
mutant $f "a file tool's path keeps its @" 'input.path.replace(/^@/, "")' 'input.path'
mutant $f "a read's ~ is not expanded" 'resolve(cwd, expandHome(path))' 'resolve(cwd, path)'
mutant $f "pi's lines after the output are rewritten with it" 'return f(body) + trailer;' 'return f(t);'
mutant $f "bash's exit status is not pi's" 'Command (?:exited with code \d+|aborted|timed out after \d+ seconds|terminated without an exit code)|' ''
mutant $f "a command with no exit code is not pi's" '|terminated without an exit code' ''
mutant $f "read's hints are not pi's" 'Use offset=\d+ to continue' 'Use offset=\d+ to go on'
mutant $f "read's hint of more lines is not pi's" '\d+ more lines in file' '\d+ more lines in the file'
mutant $f "read's hint at its byte limit is not pi's" '(?: \([^)\n]*\))?|\d+ more' '|\d+ more'
mutant $f "a hint of pi's may span lines" '(?: \([^)\n]*\))?|\d+ more' '(?: \([^)]*\))?|\d+ more'
mutant $f "a read misses the line before its offset" '.slice(0, offset - 1)' '.slice(0, offset - 2)'
mutant $f "a cut tail starts after nothing" 'text: { head: lines.slice(0, Math.max(0, cut.hidden)) },' 'text: { head: [] },'
mutant $f "a cut tail misses its last hidden line" 'Math.max(0, cut.hidden)' 'Math.max(0, cut.hidden - 1)'
mutant $f "codemode's copy leaves out nothing" 'structured: { head: [], middle: lines },' 'structured: { head: [] },'
mutant $f "an error's notice is not read" '.findLast((n) => n !== undefined);' '.findLast(() => false);'
mutant $f "the first notice is followed" '.findLast((n) => n !== undefined);' '.find((n) => n !== undefined);'
mutant $f "a byte-limit notice is not read" '(?: \([^)\n]*\))?|last' '|last'
mutant $f "a notice may span lines" '(?: \([^)\n]*\))?|last' '(?: \([^)]*\))?|last'
mutant $f "a partial-line notice may span lines" '\(line is [^)\n]*\)' '\(line is [^)]*\)'
mutant $f "a partial-line notice is not read" 'Number(m[1] ?? m[2])' 'Number(m[1])'
mutant $f "a notice the output prints is followed" 'return splitTrailer(text)[1]' 'return text'
mutant $f "a notice naming any file is followed" 'm && isBashLog(m[3]) ?' 'm ?'
mutant $f "codemode's copy is not rewritten" 'mapStrings(event.structuredContent, event.toolName === "bash" ? structured : keep(structured))' 'event.structuredContent'
mutant $f "bash's copy keeps lines like pi's" 'event.toolName === "bash" ? structured : keep(structured)' 'keep(structured)'
mutant $f "read's copy rewrites pi's lines" 'event.toolName === "bash" ? structured : keep(structured)' 'structured'
mutant $f "a changed text is not returned" '...(changed ? { content: after } : {}),' ''
mutant $f "an unchanged result is returned" 'if (!changed && JSON.stringify(copy) === JSON.stringify(event.structuredContent)) return undefined;' ''

exit $bad
