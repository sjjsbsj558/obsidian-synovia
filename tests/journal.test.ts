import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { readJournal, writeJournal } from "../src/utils/journal";

test("interrupted checkpoint recovers staged data and corrupt primary never discards a backup", async () => {
  const files = new Map<string, string>();
  let fail = false;
  const storage = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path)!,
    write: async (path: string, value: string) => {
      if (fail && path === "jobs") throw new Error("disk interruption");
      files.set(path, value);
    },
    remove: async (path: string) => { files.delete(path); }
  };
  const schema = z.object({ next: z.number() });
  await writeJournal(storage, "jobs", { next: 1 });
  fail = true;
  await assert.rejects(writeJournal(storage, "jobs", { next: 2 }), /disk/);
  assert.deepEqual(await readJournal(storage, "jobs", schema), { next: 2 });
  files.set("jobs.tmp", "{bad");
  files.set("jobs", "{bad");
  assert.deepEqual(await readJournal(storage, "jobs", schema), { next: 1 });
  files.set("jobs.bak", "{bad");
  await assert.rejects(readJournal(storage, "jobs", schema), /损坏/);
});
