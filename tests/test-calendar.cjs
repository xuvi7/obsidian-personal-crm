/** Calendar bucketing at all four scales. */
const Module = require("module");
const assert = require("assert");
const { execSync } = require("child_process");
const { makeStub } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const stub = makeStub([]);
Module._load = ((o) => (r, p, m) => (r === "obsidian" ? stub : o(r, p, m)))(Module._load);
const C = require(harness.bundleModule("src/calendar.ts"));

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

const TODAY = "2026-08-18";     // a Tuesday
const flat = (g) => g.rows.flatMap((r) => r.cells).filter(Boolean);
const at = (g, key) => flat(g).find((c) => c.key === key);
const mk = (pairs) => new Map(pairs);

console.log("Bucket keys");
{
  check("day is the date", () => assert.strictEqual(C.bucketKey("2026-08-18", "day"), "2026-08-18"));
  check("month is year-month", () => assert.strictEqual(C.bucketKey("2026-08-18", "month"), "2026-08"));
  check("year is the year", () => assert.strictEqual(C.bucketKey("2026-08-18", "year"), "2026"));
  check("week counts from Jan 1", () => {
    assert.strictEqual(C.bucketKey("2026-01-01", "week"), "2026-W01");
    assert.strictEqual(C.bucketKey("2026-01-07", "week"), "2026-W01");
    assert.strictEqual(C.bucketKey("2026-01-08", "week"), "2026-W02");
    assert.strictEqual(C.bucketKey("2026-12-31", "week"), "2026-W53");
  });
}

console.log("\nDay scale");
{
  const g = C.buildCalendar(mk([["2026-08-17", ["a"]], ["2026-08-10", ["a", "b"]]]), "day", TODAY);
  check("7 rows of 53 columns", () => {
    assert.strictEqual(g.rows.length, 7);
    assert.ok(g.rows.every((r) => r.cells.length === 53));
  });
  check("counts land on the right days", () => {
    assert.strictEqual(at(g, "2026-08-17").count, 1);
    assert.strictEqual(at(g, "2026-08-10").count, 2);
  });
  check("people are listed per period", () =>
    assert.deepStrictEqual(at(g, "2026-08-10").people, ["a", "b"]));
  check("max is the busiest period", () => assert.strictEqual(g.max, 2));
  check("in-range total counts interactions, not days", () => assert.strictEqual(g.inRange, 3));
  check("days after today are future", () => {
    for (const c of flat(g)) {
      assert.strictEqual(c.future, c.key > TODAY, c.key);
    }
  });
  check("month labels appear once per month", () => {
    const labels = g.columnLabels.filter(Boolean);
    assert.ok(labels.length >= 12 && labels.length <= 13, `${labels.length}`);
  });
}

console.log("\nWeek start");
{
  const dow = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();
  for (const [start, name] of [[0, "Sunday"], [1, "Monday"]]) {
    const g = C.buildCalendar(new Map(), "day", TODAY, { weeks: 4, weekStart: start });
    check(`${name}-start puts that weekday in the first row`, () =>
      assert.ok(g.rows[0].cells.every((c) => dow(c.key) === start), g.rows[0].cells[0].key));
  }
}

console.log("\nWeek, month and year scales");
{
  const data = mk([
    ["2026-08-17", ["a"]], ["2026-08-03", ["b"]],
    ["2025-06-15", ["a"]], ["2019-02-02", ["c"]],
  ]);
  const week = C.buildCalendar(data, "week", TODAY, { years: 6 });
  check("week rows are years, 53 columns each", () => {
    assert.ok(week.rows.every((r) => r.cells.length === 53));
    assert.ok(week.rows.some((r) => r.label === "2026"));
  });
  check("a week bucket holds its interaction", () =>
    assert.strictEqual(at(week, "2026-W33").count, 1));

  const month = C.buildCalendar(data, "month", TODAY, { years: 6 });
  check("month rows are years, 12 columns", () => {
    assert.ok(month.rows.every((r) => r.cells.length === 12));
    assert.deepStrictEqual(month.columnLabels[0], "Jan");
  });
  check("August 2026 holds both August interactions", () =>
    assert.strictEqual(at(month, "2026-08").count, 2));
  check("months after this one are future", () => {
    assert.strictEqual(at(month, "2026-09").future, true);
    assert.strictEqual(at(month, "2026-08").future, false);
  });
  check("older years beyond the limit are counted as older", () => {
    // 2019 is more than 6 years before 2026, so it falls outside.
    assert.strictEqual(month.older, 1, `older=${month.older}`);
  });

  const year = C.buildCalendar(data, "year", TODAY);
  check("year view is one row, oldest first", () => {
    assert.strictEqual(year.rows.length, 1);
    assert.strictEqual(year.rows[0].cells[0].key, "2019");
  });
  check("every year with data is present", () => {
    const keys = year.rows[0].cells.map((c) => c.key);
    for (const y of ["2019", "2025", "2026"]) assert.ok(keys.includes(y), keys.join(","));
  });
  check("nothing is older than the year view", () => assert.strictEqual(year.older, 0));
}

console.log("\nAn empty vault");
{
  const g = C.buildCalendar(new Map(), "day", TODAY);
  check("still a full grid", () => assert.strictEqual(flat(g).length, 371));
  check("with nothing in it", () => {
    assert.strictEqual(g.max, 0);
    assert.strictEqual(g.inRange, 0);
    assert.strictEqual(g.older, 0);
  });
}

console.log("\nTrailing months, for the panel thumbnail");
{
  const t = C.trailingMonths(mk([
    ["2026-08-17", ["a"]], ["2026-08-03", ["a"]],
    ["2026-01-10", ["a"]], ["2025-09-09", ["a"]], ["2024-01-01", ["a"]],
  ]), TODAY, 12);
  check("twelve months, oldest first", () => {
    assert.strictEqual(t.length, 12);
    assert.strictEqual(t[0].key, "2025-09");
    assert.strictEqual(t[11].key, "2026-08");
  });
  check("counts land in the right months", () => {
    assert.strictEqual(t.find((m) => m.key === "2026-08").count, 2);
    assert.strictEqual(t.find((m) => m.key === "2026-01").count, 1);
    assert.strictEqual(t.find((m) => m.key === "2025-09").count, 1);
  });
  check("anything older is simply absent", () =>
    assert.ok(!t.some((m) => m.key === "2024-01")));
  check("empty months are present with zero", () =>
    assert.strictEqual(t.find((m) => m.key === "2026-03").count, 0));
  check("a December rollover walks back correctly", () => {
    const j = C.trailingMonths(new Map(), "2026-01-15", 3).map((m) => m.key);
    assert.deepStrictEqual(j, ["2025-11", "2025-12", "2026-01"]);
  });
  check("labels name the month and year", () =>
    assert.strictEqual(t[11].label, "Aug 2026"));
}

console.log("\nShading");
{
  check("zero is level 0", () => assert.strictEqual(C.shade(0, 10), 0));
  check("any contact is at least level 1", () => assert.strictEqual(C.shade(1, 100), 1));
  check("the busiest period is level 4", () => assert.strictEqual(C.shade(10, 10), 4));
  check("a lone interaction is the lightest step, not the darkest", () => {
    // Every single-person calendar is a 0-or-1 range; painting its days darkest
    // would read as maximum intensity.
    assert.strictEqual(C.shade(1, 1), 1);
    assert.strictEqual(C.shade(1, 2), 1);
    assert.strictEqual(C.shade(2, 2), 2);
  });
  check("a small range maps counts straight to levels", () => {
    assert.strictEqual(C.shade(3, 4), 3);
    assert.strictEqual(C.shade(4, 4), 4);
    assert.strictEqual(C.shade(9, 4), 4);
  });
  check("a wide range spreads the low counts", () => {
    assert.strictEqual(C.shade(1, 20), 1);
    assert.strictEqual(C.shade(2, 20), 2);
    assert.strictEqual(C.shade(20, 20), 4);
  });
  check("levels stay inside 0-4", () => {
    for (let n = 0; n <= 50; n++) {
      const v = C.shade(n, 37);
      assert.ok(v >= 0 && v <= 4, `${n} -> ${v}`);
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
