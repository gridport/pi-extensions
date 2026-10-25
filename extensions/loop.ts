/**
 * Loop: fires a saved prompt into this session on a cron schedule, as Claude
 * Code's CronCreate does. The agent arms jobs with the `loop` tool; /loop
 * lists, adds and deletes them by hand.
 *
 * - A job fires only while the session is idle. A firing that comes due while
 *   the agent is busy or compacting is sent once it settles, and firings missed
 *   while busy or asleep collapse into one.
 * - After you press Esc, pending firings wait 5 minutes, so the session stays
 *   yours to type into.
 * - Times are local. Across a daylight-saving change, a job in the repeated
 *   hour fires twice and one in the skipped hour not at all, unlike cron.
 * - Jobs belong to this session. They survive /reload, but not a restart, /new,
 *   /resume or /fork; a restarted or forked session says which jobs lapsed.
 * - A job expires 7 days after it was created.
 * - The same prompt can't be armed twice, so a renewal can't double a loop.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MINUTE = 60_000;
const EXPIRY_MS = 7 * 24 * 60 * MINUTE;
const HOLD_AFTER_ESC_MS = 5 * MINUTE;
const ENTRY = "loop-jobs";
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface Job {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  expiresAt: number;
}

interface LiveJob extends Job {
  /** The last minute already checked for a match. */
  checked: number;
  /** The minute the pending firing came due, if one is pending. */
  due?: number;
}

/** Saved with both marks, so a reload resumes where the old runtime stopped. */
type SavedJob = Job & { checked?: number; due?: number };

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  anyDom: boolean;
  anyDow: boolean;
}

function parseField(text: string, lo: number, hi: number): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid cron field "${text}"`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let from = lo;
    let to = hi;
    if (!m[1]) {
      from = Number(m[2]);
      to = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
    }
    if (from < lo || to > hi || from > to || step < 1) {
      throw new Error(`cron field "${text}" must stay within ${lo}-${hi}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** Five fields, as cron reads them: minute hour day-of-month month day-of-week. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron needs 5 fields (minute hour day-of-month month day-of-week), got "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, RANGES[i][0], RANGES[i][1]));
  if (dow.has(7)) dow.add(0);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    anyDom: parts[2].startsWith("*"),
    anyDow: parts[4].startsWith("*"),
  };
}

/** Local time. As in cron, a day matches either day field when both are restricted. */
export function matches(c: Cron, t: Date): boolean {
  if (!c.minute.has(t.getMinutes()) || !c.hour.has(t.getHours()) || !c.month.has(t.getMonth() + 1))
    return false;
  const dom = c.dom.has(t.getDate());
  const dow = c.dow.has(t.getDay());
  return c.anyDom || c.anyDow ? dom && dow : dom || dow;
}

export const minuteOf = (t: number) => Math.floor(t / MINUTE) * MINUTE;

/** The first matching minute in (after, until], or undefined. */
export function firstMatch(c: Cron, after: number, until: number): number | undefined {
  for (let t = minuteOf(after) + MINUTE; t <= until; t += MINUTE) {
    if (matches(c, new Date(t))) return t;
  }
  return undefined;
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function (pi: ExtensionAPI) {
  let jobs: LiveJob[] = [];
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holdUntil = 0;
  const crons = new Map<string, Cron>();

  const cronOf = (job: Job) => {
    let c = crons.get(job.cron);
    if (!c) {
      c = parseCron(job.cron);
      crons.set(job.cron, c);
    }
    return c;
  };

  const save = () => {
    pi.appendEntry(ENTRY, { jobs: jobs.map((j) => ({ ...j })) });
  };

  const status = () => {
    if (!ctx) return;
    if (jobs.length === 0) {
      ctx.ui.setStatus("loop", undefined);
      return;
    }
    const now = Date.now();
    const next = Math.min(...jobs.map((j) => firstMatch(cronOf(j), now, j.expiresAt) ?? Infinity));
    const when = Number.isFinite(next) ? stamp(next).slice(11) : "none";
    ctx.ui.setStatus("loop", `loop ×${jobs.length}, next ${when}`);
  };

  const describe = (job: LiveJob) => {
    const next = firstMatch(cronOf(job), Date.now(), job.expiresAt);
    const parts = [
      job.id,
      `"${job.cron}"`,
      job.recurring ? "recurring" : "once",
      `next ${next ? stamp(next) : "none before expiry"}`,
      `expires ${stamp(job.expiresAt)}`,
    ];
    if (job.due !== undefined) parts.push(`due since ${stamp(job.due)}`);
    return `${parts.join("  ")}\n  ${job.prompt.replace(/\s+/g, " ").slice(0, 120)}`;
  };

  const list = () => (jobs.length ? jobs.map(describe).join("\n") : "No loop jobs.");

  // Send the oldest pending firing, if the session is idle. The rest wait for
  // the run it starts to settle.
  const deliver = () => {
    if (!ctx?.isIdle() || ctx.hasPendingMessages() || Date.now() < holdUntil) return;
    const job = jobs.filter((j) => j.due !== undefined).sort((a, b) => (a.due ?? 0) - (b.due ?? 0))[0];
    if (!job || job.due === undefined) return;
    const due = job.due;
    job.due = undefined;
    if (!job.recurring) {
      jobs = jobs.filter((j) => j !== job);
      save();
    }
    pi.sendUserMessage(`[loop ${job.id}, "${job.cron}", due ${stamp(due)}]\n\n${job.prompt}`);
  };

  const tick = () => {
    timer = undefined;
    try {
      const now = Date.now();
      const slot = minuteOf(now);
      const expired = jobs.filter((j) => now >= j.expiresAt);
      if (expired.length) {
        jobs = jobs.filter((j) => now < j.expiresAt);
        save();
        ctx?.ui.notify(`Loop jobs expired after 7 days: ${expired.map((j) => j.id).join(", ")}`, "warning");
      }
      for (const job of jobs) {
        if (job.due === undefined) job.due = firstMatch(cronOf(job), job.checked, slot);
        // A clock stepped back must not re-check minutes already fired.
        job.checked = Math.max(job.checked, slot);
      }
      deliver();
    } catch (err) {
      // A throw here would escape the timer and could take pi down.
      ctx?.ui.notify(`loop: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      schedule();
      status();
    }
  };

  // Tick just after each minute boundary, and only while there are jobs.
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!ctx || jobs.length === 0) return;
    timer = setTimeout(tick, MINUTE - (Date.now() % MINUTE) + 250);
  };

  const create = (cron: string, prompt: string, recurring: boolean): LiveJob => {
    const c = parseCron(cron);
    const text = prompt.trim();
    if (!text) throw new Error("prompt is empty");
    const twin = jobs.find((j) => j.prompt.trim() === text);
    if (twin)
      throw new Error(`job ${twin.id} already sends this prompt; delete it first to change its schedule`);
    const now = Date.now();
    const expiresAt = now + EXPIRY_MS;
    if (firstMatch(c, now, expiresAt) === undefined) {
      throw new Error(`"${cron}" does not fire in the next 7 days, before the job would expire`);
    }
    let id: string;
    do id = Math.random().toString(16).slice(2, 8);
    while (jobs.some((j) => j.id === id));
    const job: LiveJob = {
      id,
      cron: cron.trim().split(/\s+/).join(" "),
      prompt: text,
      recurring,
      createdAt: now,
      expiresAt,
      checked: minuteOf(now),
    };
    crons.set(job.cron, c);
    jobs.push(job);
    save();
    schedule();
    status();
    return job;
  };

  const remove = (id: string): string[] => {
    const gone = id === "all" ? jobs : jobs.filter((j) => j.id === id);
    if (gone.length === 0) throw new Error(`no loop job "${id}". ${list()}`);
    jobs = jobs.filter((j) => !gone.includes(j));
    save();
    schedule();
    status();
    return gone.map((j) => j.id);
  };

  const lastSaved = (c: ExtensionContext): SavedJob[] => {
    const entries = c.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === ENTRY)
        return (e.data as { jobs?: SavedJob[] } | undefined)?.jobs ?? [];
    }
    return [];
  };

  pi.on("session_start", (event, c) => {
    ctx = c;
    const now = Date.now();
    const saved = lastSaved(c).filter((j) => now < j.expiresAt);
    jobs = [];
    if (event.reason === "reload") {
      for (const j of saved) {
        try {
          cronOf(j);
          // Resume from the old runtime's last check, so neither a minute that
          // passed during the reload nor a pending firing is lost.
          jobs.push({ ...j, checked: j.checked ?? minuteOf(now), due: j.due });
        } catch {
          // A job saved by an incompatible version is dropped.
        }
      }
    } else if (saved.length) {
      save();
      c.ui.notify(
        `Loop jobs from before the restart are not armed: ${saved.map((j) => `${j.id} "${j.cron}"`).join(", ")}. Ask the agent to arm them again if they are still wanted.`,
        "warning",
      );
    }
    schedule();
    status();
  });

  pi.on("agent_settled", (event, c) => {
    ctx = c;
    if (event.aborted) {
      holdUntil = Date.now() + HOLD_AFTER_ESC_MS;
      return;
    }
    deliver();
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "reload" && jobs.length) save();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    ctx = undefined;
  });

  pi.registerTool({
    name: "loop",
    label: "Loop",
    description:
      "Fire a prompt into this session on a cron schedule: 5 fields (minute hour day-of-month month day-of-week), local time. " +
      "A job fires only while the session is idle; firings that come due while it is busy are sent once, when it settles. " +
      "Jobs live in this session only (they survive /reload, not a restart) and expire 7 days after creation. " +
      "The same prompt can't be armed twice. Actions: create (cron, prompt, recurring), list, delete (id, or all).",
    parameters: Type.Object({
      action: StringEnum(["create", "list", "delete"] as const),
      cron: Type.Optional(Type.String({ description: 'For create, e.g. "7 * * * *" for every hour at :07' })),
      prompt: Type.Optional(Type.String({ description: "For create: the whole prompt each firing sends" })),
      recurring: Type.Optional(
        Type.Boolean({ description: "For create: false fires once and deletes the job. Default true" }),
      ),
      id: Type.Optional(Type.String({ description: 'For delete: a job id, or "all"' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, c) {
      ctx = c;
      let text: string;
      if (params.action === "create") {
        if (!params.cron || !params.prompt) throw new Error("create needs cron and prompt");
        const job = create(params.cron, params.prompt, params.recurring ?? true);
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        text = `Armed (times in ${zone}):\n${describe(job)}`;
      } else if (params.action === "delete") {
        if (!params.id) throw new Error("delete needs id");
        text = `Deleted ${remove(params.id).join(", ")}. ${list()}`;
      } else {
        text = list();
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerCommand("loop", {
    description: "List loop jobs; /loop delete <id|all>; /loop <5 cron fields> <prompt> adds a recurring job",
    handler: async (args, c) => {
      ctx = c;
      const a = args.trim();
      try {
        if (!a || a === "list") {
          c.ui.notify(list(), "info");
        } else if (a === "delete" || a.startsWith("delete ")) {
          const id = a.slice(6).trim();
          if (!id) throw new Error("usage: /loop delete <id|all>");
          c.ui.notify(`Deleted ${remove(id).join(", ")}`, "info");
        } else {
          const m = /^((?:\S+\s+){4}\S+)\s+([\s\S]+)$/.exec(a);
          if (!m) throw new Error("usage: /loop <minute hour day month weekday> <prompt>");
          c.ui.notify(`Armed:\n${describe(create(m[1], m[2], true))}`, "info");
        }
      } catch (err) {
        c.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
