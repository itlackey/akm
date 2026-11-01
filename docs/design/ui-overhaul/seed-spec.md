# Visual seed dataset

Source: [plan.md](plan.md) Appendix C. The plan wins where this file differs.

**Constants:** `FIXED_NOW = 2026-06-17T14:20:00Z`, port 9391, token `visual-token`. Every timestamp is written explicitly, relative to `FIXED_NOW`.

**Seeded data**
- **Searches:** 13 weeks of user searches, about 40 a week:
  - 6% found nothing;
  - 3 repeat misses on ≥ 2 days;
  - one burst of 8 identical failing queries within 10 minutes (tests the repeat merge);
  - `totalMs` on 90%.
- **Curates:** daily curate rows (hook-like).
- **Feedback:** signed, with 2 negatives in the last 7 days (including `stash//lessons/rg`, reason "outdated flag").
- **Proposals** across reflect, distill, consolidate, consolidate-pair, extract and feedback, in every status:
  - pending in each age band, plus one unknown age;
  - judge-accepted (`auto-accepted`/`triage`);
  - you-accepted;
  - staged-then-accepted;
  - judge-rejected;
  - you-rejected;
  - procedural (expired);
  - reverted;
  - one no-op;
  - one create;
  - one retire with continuity risk;
  - one reopened.
- **Improve runs:** 14, with 1 failed and 1 dry run.
- **Tasks:** 2, with 1 failed and 1 `active` started 8 h ago.
- **llm_usage:** per process, with one week at 40% token coverage.
- **Assets:** a command asset (template body) and a knowledge asset with feedback and proposals.
- **Git:** a stash with 6 dated commits, one with a subject naming an accepted ref.
- **Index:** one full reindex event and one retirement batch (3 in a day).

**Variants**
- **Empty:** a fresh sandbox.
- **Low data:** 1 active day, 6 searches.
- **Data starts mid-window:** the oldest `usage_events` row is 20 days ago.
- **Long content:** an 80-char ref, a 120-char query, a 6-digit count, a 40-segment path.
