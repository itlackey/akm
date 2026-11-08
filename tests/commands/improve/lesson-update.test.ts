import { describe, expect, test } from "bun:test";
import { buildLessonUpdatePrompt, memoryFactCandidates } from "../../../src/commands/improve/distill/lesson-update";

const memory = [
  "Restoring the nightly backup took 25 minutes for 40 GB on 2026-10-03.",
  "The restore.sh script on host db-eu1 failed until we raised the Timeout to 90s, per Postgres docs.",
].join("\n");
const lesson = "Test restores before trusting a backup.\nA backup that was never restored is not a backup.";

describe("memoryFactCandidates (#1405)", () => {
  test("lists the memory's figures and names the lesson lacks", () => {
    const facts = memoryFactCandidates(memory, lesson);
    for (const want of ["25 minutes", "40 GB", "2026-10-03", "restore.sh", "db-eu1", "90s", "Postgres"]) {
      expect(facts).toContain(want);
    }
  });

  test("omits what the lesson already states, in any case", () => {
    const facts = memoryFactCandidates(memory, `${lesson}\nRestores took 25 MINUTES; see restore.sh.`);
    expect(facts).not.toContain("25 minutes");
    expect(facts).not.toContain("restore.sh");
    expect(facts).toContain("40 GB");
  });

  test("a figure stops at its number: no trailing words or punctuation", () => {
    const facts = memoryFactCandidates("Issue 212 was closed after 3 retries, and 4.2, which shipped, fixed it.", "x");
    expect(facts).toEqual(["212", "3 retries", "4.2"]);
  });

  test("a figure is present only as a whole word: 30 is not in 300", () => {
    expect(memoryFactCandidates("Set the TTL to 30.", "Cache 300 s.")).toContain("30");
    expect(memoryFactCandidates("Set the TTL to 30.", "Cache 30 s.")).not.toContain("30");
  });

  test("names keep their accents", () => {
    expect(memoryFactCandidates("The job in Zürich failed, said José Núñez.", "x")).toEqual(["Zürich", "José Núñez"]);
  });

  test("the update prompt lists each lesson's own missing facts", () => {
    const other = "Restores took 25 minutes on db-eu1.";
    const prompt = buildLessonUpdatePrompt(
      memory,
      [],
      [
        { ref: "lesson:a", body: lesson },
        { ref: "lesson:b", body: other },
      ],
    );
    const [, blockB] = prompt.split("Existing lesson ref: lesson:b");
    expect(prompt.split("Existing lesson ref: lesson:b")[0]).toContain("25 minutes");
    expect(blockB).not.toMatch(/lacks: .*25 minutes/);
    expect(blockB).not.toMatch(/lacks: .*db-eu1/);
  });

  test("the update prompt hands the writer the list", () => {
    const prompt = buildLessonUpdatePrompt(memory, [], [{ ref: "lesson:backups", body: lesson }]);
    expect(prompt).toContain("25 minutes");
    expect(prompt).toContain("db-eu1");
  });

  test("no candidates, no list", () => {
    const prompt = buildLessonUpdatePrompt("Always test restores.", [], [{ ref: "lesson:backups", body: lesson }]);
    expect(prompt).not.toContain("Figures and names");
  });
});
