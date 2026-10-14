/**
 * Session persistence.
 *
 * One file per session keeps concurrent sessions isolated: two runs in different
 * sessions must never contend for the same bytes, which is exactly what a single
 * shared file would force.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { Session } from "../core/contracts.ts";

export interface SessionStore {
  createSession(): Promise<Session>;
  loadSession(id: string): Promise<Session | undefined>;
  saveSession(session: Session): Promise<void>;
  listSessions(): Promise<Session[]>;
}

export type IdGenerator = () => string;

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly newId: IdGenerator) {}

  async createSession(): Promise<Session> {
    const session: Session = { id: this.newId(), createdAt: Date.now(), runs: [] };
    this.sessions.set(session.id, session);
    return session;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : structuredClone(session);
  }

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }
}

export class JsonSessionStore implements SessionStore {
  private readonly directory: string;
  /** Per-session write chains, so two saves of one session cannot interleave. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private temporaryCounter = 0;

  constructor(
    directory: string,
    private readonly newId: IdGenerator,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = path.join(directory, "sessions");
  }

  static async open(directory: string, newId: IdGenerator): Promise<JsonSessionStore> {
    const store = new JsonSessionStore(directory, newId);
    await fs.mkdir(store.directory, { recursive: true });
    return store;
  }

  private sessionFile(id: string): string {
    return path.join(this.directory, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  async createSession(): Promise<Session> {
    const session: Session = { id: this.newId(), createdAt: this.now(), runs: [] };
    await this.saveSession(session);
    return session;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    try {
      const raw = await fs.readFile(this.sessionFile(id), "utf8");
      return JSON.parse(raw) as Session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveSession(session: Session): Promise<void> {
    // Snapshot synchronously: `run()` mutates `session.runs` while writes are in
    // flight, so serialising the live object would persist a later state than the one
    // being recorded.
    const snapshot: Session = { ...session, runs: [...session.runs] };

    await this.serialize(snapshot.id, async () => {
      // Write-then-rename: a crash mid-write leaves the previous good file intact
      // rather than a truncated one.
      const target = this.sessionFile(snapshot.id);
      // The temporary name must be unique per write. A fixed `<target>.tmp` meant two
      // concurrent saves of one session wrote the same path, and whichever renamed
      // second failed with ENOENT — which is exactly what happened whenever two runs
      // started in one session, since each saves the session at start and at end.
      this.temporaryCounter += 1;
      const temporary = `${target}.${process.pid}.${this.temporaryCounter}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf8");
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  /** Run writes for one session in order, so they cannot interleave or race. */
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async listSessions(): Promise<Session[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const sessions: Session[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        sessions.push(JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8")) as Session);
      } catch {
        continue;
      }
    }
    return sessions;
  }
}
