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
    // Write-then-rename: a crash mid-write leaves the previous good file intact
    // rather than a truncated one.
    const target = this.sessionFile(session.id);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(temporary, target);
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
