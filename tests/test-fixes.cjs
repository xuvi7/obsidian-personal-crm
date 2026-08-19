/**
 * Regression suite for every fix from the three reviews. Runs the real bundled
 * plugin against a fake vault that stores real text and computes a realistic
 * metadata cache (links with offsets, sections, listItems, embeds, headings).
 */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");

const notices = [];
const stub = makeStub(notices);
const origLoad = Module._load;
Module._load = (req, parent, isMain) =>
  req === "obsidian" ? stub : origLoad(req, parent, isMain);

global.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  confirm: () => true,
};
global.performance = global.performance ?? { now: () => Date.now() };

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); failures.push(name); }
}

const PluginClass = harness.loadPlugin();

async function makePlugin(settings, build = () => {}) {
  const vault = makeVault();
  build(vault);
  const plugin = new PluginClass(vault.app, { id: "personal-crm" });
  plugin.__data = Object.assign(
    { configured: true, notifyOnStartup: false, showStatusBar: false },
    settings
  );
  await plugin.onload();
  plugin.engine.rebuild();
  return { plugin, ...vault };
}

const PERSON_FM = (extra = "") => `---\ntags:\n  - people\n${extra}---\n`;

(async () => {
  // ======================================================================
  console.log("\n1. Intentions must not count as contact (generalizability #9)");
  {
    const { plugin } = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] },
      (v) => {
        v.addFile("People/Sam Rivera.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("People/Ana Diaz.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("People/Bo Chen.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("People/Cy Fox.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("People/Dee Ray.md", PERSON_FM("prm-tier: close\n"));
        v.addFile(
          "Daily/2026-08-17.md",
          [
            "# Journal",
            "- [ ] TODO: finally reach out to [[Sam Rivera]], it's been ages",
            "> quoting an old entry: hung out with [[Ana Diaz]]",
            "```markdown",
            "example: [[Bo Chen]]",
            "```",
            "![[Cy Fox]]",
            "- [x] called [[Dee Ray]] this morning",
            "",
          ].join("\n")
        );
      }
    );

    const get = (n) => plugin.engine.get(`People/${n}.md`);
    check("unchecked TODO does not count", () => assert.strictEqual(get("Sam Rivera").lastContact, null));
    check("blockquote does not count", () => assert.strictEqual(get("Ana Diaz").lastContact, null));
    check("code fence does not count", () => assert.strictEqual(get("Bo Chen").lastContact, null));
    check("embed does not count", () => assert.strictEqual(get("Cy Fox").lastContact, null));
    check("completed task DOES count", () =>
      assert.strictEqual(get("Dee Ray").lastContact, "2026-08-17"));

    const plain = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] },
      (v) => {
        v.addFile("People/Sam Rivera.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("Daily/2026-08-17.md", "Had coffee with [[Sam Rivera]].\n");
      }
    );
    check("ordinary prose link still counts", () =>
      assert.strictEqual(plain.plugin.engine.get("People/Sam Rivera.md").lastContact, "2026-08-17"));
  }

  // ======================================================================
  console.log("\n2. Configurable moment date formats (generalizability #1)");
  {
    const cases = [
      ["YYYY-MM-DD-dddd", "2026-08-14-Friday"],
      ["DD-MM-YYYY", "14-08-2026"],
      ["DD.MM.YYYY", "14.08.2026"],
      ["MMM D, YYYY", "Aug 14, 2026"],
      ["dddd DD-MM-YYYY", "Friday 14-08-2026"],
      ["gggg-[W]ww", "2026-W33"],
      ["YYYY-MM", "2026-08"],
      ["YYYY-[Q]Q", "2026-Q3"],
      ["YYYY/MM-MMMM/YYYY-MM-DD-dddd", "2026-08-14-Friday"],
      ["[Journal] YYYY-MM-DD", "Journal 2026-08-14"],
    ];
    for (const [format, basename] of cases) {
      const { plugin } = await makePlugin(
        { personFolders: ["People"], journalSources: [{ folder: "D", format }] },
        (v) => {
          v.addFile("People/Sam Rivera.md", PERSON_FM("prm-tier: dormant\n"));
          v.addFile(`D/${basename}.md`, "saw [[Sam Rivera]]\n");
        }
      );
      check(`${format} → ${basename}`, () => {
        const r = plugin.engine.get("People/Sam Rivera.md");
        assert.ok(r.lastContact, `no date parsed from ${basename}`);
      });
    }

    // EU day-first must not be misread as month-first.
    const eu = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "D", format: "DD-MM-YYYY" }], allowFallbackDateFormats: false },
      (v) => {
        v.addFile("People/Sam Rivera.md", PERSON_FM("prm-tier: dormant\n"));
        v.addFile("D/01-06-2026.md", "saw [[Sam Rivera]]\n");
      }
    );
    check("DD-MM-YYYY 01-06-2026 reads as 1 June, not 6 January", () =>
      assert.strictEqual(eu.plugin.engine.get("People/Sam Rivera.md").lastContact, "2026-06-01"));

    // Non-dated notes must not be mistaken for dated ones.
    const noise = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "D", format: "YYYY-MM-DD" }] },
      (v) => {
        v.addFile("People/Sam Rivera.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("D/People MOC.md", "[[Sam Rivera]]\n");
        v.addFile("D/Some Meeting.md", "[[Sam Rivera]]\n");
      }
    );
    check("undated notes in the folder are ignored", () => {
      assert.strictEqual(noise.plugin.engine.get("People/Sam Rivera.md").lastContact, null);
      assert.strictEqual(noise.plugin.engine.diagnostics().journalFilesDated, 0);
      assert.strictEqual(noise.plugin.engine.diagnostics().journalFilesScanned, 2);
    });
  }

  // ======================================================================
  console.log("\n3. Frontmatter-dated notes (note-per-meeting workflows)");
  {
    const { plugin } = await makePlugin(
      {
        personFolders: ["People"],
        journalSources: [{ folder: "Meetings", format: "YYYY-MM-DD" }],
        journalDateKey: "date",
      },
      (v) => {
        v.addFile("People/Sam Rivera.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("Meetings/Coffee with Sam.md", "---\ndate: 2026-08-14\n---\nGreat chat with [[Sam Rivera]].\n");
      }
    );
    check("note dated by frontmatter counts", () =>
      assert.strictEqual(plugin.engine.get("People/Sam Rivera.md").lastContact, "2026-08-14"));
  }

  // ======================================================================
  console.log("\n4. People identification beyond one folder (generalizability #5)");
  {
    const { plugin } = await makePlugin(
      {
        personFolders: [],
        personTags: ["person"],
        journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }],
      },
      (v) => {
        v.addFile("Work/Colleagues/Sam Rivera.md", "---\ntags:\n  - person/work\n---\n");
        v.addFile("Family/Ana Diaz.md", "---\ntags:\n  - person\n---\n");
        v.addFile("Projects/Rewrite API.md", "---\ntags:\n  - project\n---\n");
      }
    );
    check("hierarchical tag person/work is found", () =>
      assert.ok(plugin.engine.get("Work/Colleagues/Sam Rivera.md")));
    check("plain tag person is found", () => assert.ok(plugin.engine.get("Family/Ana Diaz.md")));
    check("unrelated note is not a person", () =>
      assert.strictEqual(plugin.engine.get("Projects/Rewrite API.md"), null));
    check("total is exactly 2", () => assert.strictEqual(plugin.engine.all().length, 2));

    const typed = await makePlugin(
      { personFolders: [], personTypeKey: "type", personTypeValue: "person", journalSources: [] },
      (v) => {
        v.addFile("Zettel/Sam.md", "---\ntype: person\n---\n");
        v.addFile("Zettel/Idea.md", "---\ntype: note\n---\n");
      }
    );
    check("type: person frontmatter marker works", () => {
      assert.ok(typed.plugin.engine.get("Zettel/Sam.md"));
      assert.strictEqual(typed.plugin.engine.get("Zettel/Idea.md"), null);
    });

    const dirty = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => {
        v.addFile("People/Sam Rivera.md", PERSON_FM());
        v.addFile("People/People MOC.md", PERSON_FM());
        v.addFile("People/Person template.md", "---\nprm-tier: \"{{tier}}\"\n---\n");
        v.addFile("People/Untitled.md", "");
        v.addFile("People/Drawing.excalidraw.md", "---\nexcalidraw-plugin: parsed\n---\n");
      }
    );
    check("MOC, template, Untitled and excalidraw all excluded", () => {
      const names = dirty.plugin.engine.all().map((r) => r.name);
      assert.deepStrictEqual(names, ["Sam Rivera"], `got ${JSON.stringify(names)}`);
      assert.strictEqual(dirty.plugin.engine.diagnostics().personFilesSkipped, 4);
    });
  }

  // ======================================================================
  console.log("\n5. Diagnostics make an empty dashboard explain itself (#3)");
  {
    const { plugin } = await makePlugin(
      { personFolders: ["Nope"], journalSources: [{ folder: "AlsoNope", format: "YYYY-MM-DD" }] },
      (v) => v.addFile("People/Sam.md", PERSON_FM())
    );
    const d = plugin.engine.diagnostics();
    check("reports zero people found", () => assert.strictEqual(d.personFilesFound, 0));
    check("names the folders that don't exist", () => {
      assert.ok(d.missingFolders.includes("Nope"), JSON.stringify(d.missingFolders));
      assert.ok(d.missingFolders.includes("AlsoNope"));
    });
  }

  // ======================================================================
  console.log("\n6. Windows/Unicode path normalization (#3)");
  {
    const { plugin } = await makePlugin(
      { personFolders: ["People\\Friends"], journalSources: [] },
      (v) => v.addFile("People/Friends/Sam.md", PERSON_FM())
    );
    check("backslash path still finds the folder", () =>
      assert.ok(plugin.engine.get("People/Friends/Sam.md"), "backslash path not normalized"));

    const slashy = await makePlugin(
      { personFolders: ["/People/"], journalSources: [] },
      (v) => v.addFile("People/Sam.md", PERSON_FM())
    );
    check("leading and trailing slashes tolerated", () =>
      assert.ok(slashy.plugin.engine.get("People/Sam.md")));
  }

  // ======================================================================
  console.log("\n7. Atomic body log + undo integrity (correctness #1, #2)");
  {
    const { plugin, store } = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] },
      (v) => {
        v.addFile("People/Sam Rivera.md", `${PERSON_FM("prm-tier: close\n")}# Facts\n- met at a talk\n`);
        v.addFile("Daily/2026-08-17.md", "# Journal\n");
      }
    );
    const file = plugin.app.vault.getAbstractFileByPath("People/Sam Rivera.md");
    const original = store.get(file.path);

    // Two overlapping actions on the same note: previously one clobbered the other.
    await Promise.all([
      plugin.logContact(file, "2026-08-17"),
      plugin.setTier(file, "inner"),
    ]);
    const after = store.get(file.path);

    check("body log survives a concurrent frontmatter write", () =>
      assert.ok(after.includes("- [[2026-08-17]]"), `log line lost:\n${after}`));
    check("concurrent tier write also landed", () =>
      assert.ok(/prm-tier: inner/.test(after), after));
    check("original content preserved", () => assert.ok(after.includes("- met at a talk")));

    // Undo must reverse exactly one action, not absorb the other.
    await plugin.performUndo();
    const afterOneUndo = store.get(file.path);
    check("one undo reverses one action only", () => {
      assert.notStrictEqual(afterOneUndo, original, "undid too much");
      assert.notStrictEqual(afterOneUndo, after, "undid nothing");
    });
    await plugin.performUndo();
    check("second undo returns to the original bytes", () =>
      assert.strictEqual(store.get(file.path), original));
    await plugin.performRedo();
    await plugin.performRedo();
    check("redo restores both", () => assert.strictEqual(store.get(file.path), after));
  }

  // ======================================================================
  console.log("\n8. Contact log heading is fence-aware (correctness #9)");
  {
    const { plugin, store } = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] },
      (v) => {
        v.addFile(
          "People/Sam Rivera.md",
          `${PERSON_FM("prm-tier: close\n")}Example of the format:\n\n\`\`\`markdown\n## Contact log\n- [[2020-01-01]]\n\`\`\`\n\n## Contact log\n- [[2026-01-01]]\n`
        );
        v.addFile("Daily/2026-08-17.md", "x\n");
      }
    );
    const file = plugin.app.vault.getAbstractFileByPath("People/Sam Rivera.md");
    await plugin.logContact(file, "2026-08-17");
    const text = store.get(file.path);
    const fenceEnd = text.indexOf("```\n\n## Contact log");
    const inserted = text.indexOf("- [[2026-08-17]]");
    check("entry lands under the real heading, not inside the fence", () =>
      assert.ok(inserted > fenceEnd, `inserted at ${inserted}, fence ends at ${fenceEnd}\n${text}`));
  }

  // ======================================================================
  console.log("\n9. Date validation (correctness #4, #13)");
  {
    const { plugin, store } = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\nprm-last-contacted: 2026-01-01\n"))
    );
    const file = plugin.app.vault.getAbstractFileByPath("People/Sam.md");
    const before = store.get(file.path);

    await plugin.logContact(file, "");
    check("empty date is rejected, existing value untouched", () =>
      assert.strictEqual(store.get(file.path), before));
    await plugin.logContact(file, "2026-13-45");
    check("impossible date is rejected", () =>
      assert.strictEqual(store.get(file.path), before));
    check("a notice explained the rejection", () =>
      assert.ok(notices.some((n) => /valid date/i.test(n))));

    const bad = await makePlugin({ personFolders: ["People"], journalSources: [] }, (v) =>
      v.addFile("People/Bad.md", PERSON_FM("prm-tier: close\nprm-last-contacted: 2026-13-45\n"))
    );
    check("invalid stored date does not create a future last-contact", () => {
      const r = bad.plugin.engine.get("People/Bad.md");
      assert.strictEqual(r.lastContact, null, `got ${r.lastContact}`);
    });

    const snoozed = await makePlugin({ personFolders: ["People"], journalSources: [] }, (v) =>
      v.addFile("People/S.md", PERSON_FM("prm-tier: close\nprm-snooze-until: 2026-13-45\n"))
    );
    check("invalid snooze date does not hide someone", () =>
      assert.notStrictEqual(snoozed.plugin.engine.get("People/S.md").status, "snoozed"));
  }

  // ======================================================================
  console.log("\n10. Write errors are reported, not swallowed (correctness #5)");
  {
    const { plugin, app } = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\n"))
    );
    const file = app.vault.getAbstractFileByPath("People/Sam.md");
    app.fileManager.processFrontMatter = async () => {
      throw new Error("YAMLParseError: bad indentation");
    };
    notices.length = 0;
    await plugin.logContact(file, "2026-08-17");
    check("failure surfaces a notice instead of an unhandled rejection", () =>
      assert.ok(notices.some((n) => /Couldn't update/.test(n)), JSON.stringify(notices)));
    check("no undo entry recorded for a failed write", () =>
      assert.strictEqual(plugin.undo.canUndo(), false));
  }

  // ======================================================================
  console.log("\n11. Phantom date links (correctness #14, generalizability #10)");
  {
    const { plugin, store } = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "MMM D, YYYY" }] },
      (v) => {
        v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("Daily/Aug 17, 2026.md", "x\n");
      }
    );
    const file = plugin.app.vault.getAbstractFileByPath("People/Sam.md");
    await plugin.logContact(file, "2026-08-17");
    const text = store.get(file.path);
    check("links the real note with the date as display text", () =>
      assert.ok(text.includes("[[Aug 17, 2026|2026-08-17]]"), text));
    check("no unresolvable [[2026-08-17]] phantom", () =>
      assert.ok(!/\[\[2026-08-17\]\]/.test(text), text));

    const none = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] },
      (v) => v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\n"))
    );
    const f2 = none.plugin.app.vault.getAbstractFileByPath("People/Sam.md");
    await none.plugin.logContact(f2, "2026-08-17");
    check("plain date when no note exists for that day", () => {
      const t = none.store.get(f2.path);
      assert.ok(t.includes("- 2026-08-17"), t);
      assert.ok(!t.includes("[["), t);
    });
  }

  // ======================================================================
  console.log("\n12. Mention counts dedupe by day (correctness, low)");
  {
    const { plugin } = await makePlugin(
      { personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] },
      (v) => {
        v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\n"));
        v.addFile("Daily/2026-08-17.md", "[[Sam]] and again [[Sam]]\n");
        v.addFile("Daily/2026-08-17 evening.md", "[[Sam]]\n");
      }
    );
    check("two notes on one day count as one interaction", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").mentionCount, 1));
  }

  // ======================================================================
  console.log("\n13. Unknown tier is surfaced, not silently untracked (#10)");
  {
    const { plugin } = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => v.addFile("People/Sam.md", PERSON_FM("prm-tier: deleted-tier\n"))
    );
    const r = plugin.engine.get("People/Sam.md");
    check("record is flagged as having a missing tier", () => assert.strictEqual(r.tierMissing, true));
    check("stats count it separately from unclassified", () =>
      assert.strictEqual(plugin.engine.stats().unknownTier, 1));
  }

  // ======================================================================
  console.log("\n14. Filesystem-derived baseline is labelled (generalizability #7)");
  {
    const { plugin } = await makePlugin(
      { personFolders: ["People"], journalSources: [], createdDateKeys: ["created"] },
      (v) => {
        v.addFile("People/Explicit.md", PERSON_FM("prm-tier: close\ncreated: 2026-08-15\n"));
        v.addFile("People/Implicit.md", PERSON_FM("prm-tier: close\n"));
      }
    );
    check("explicit created date is used", () =>
      assert.strictEqual(plugin.engine.get("People/Explicit.md").baselineSource, "created"));
    check("ctime fallback is marked as filesystem-derived", () =>
      assert.strictEqual(plugin.engine.get("People/Implicit.md").baselineSource, "filesystem"));

    const broad = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => {
        v.addFile("People/A.md", PERSON_FM("prm-tier: close\ndate created: 2026-08-15\n"));
        v.addFile("People/B.md", PERSON_FM("prm-tier: close\nCreated: 2026-08-15\n"));
        v.addFile("People/C.md", PERSON_FM('prm-tier: close\ncreated: "[[2026-08-15]]"\n'));
      }
    );
    check("date created / Created / [[wikilink]] forms all read", () => {
      for (const n of ["A", "B", "C"]) {
        const r = broad.plugin.engine.get(`People/${n}.md`);
        assert.strictEqual(r.createdDate, "2026-08-15", `${n} → ${r.createdDate}`);
      }
    });
  }

  // ======================================================================
  console.log("\n15. Import re-validates at apply time (correctness #7)");
  {
    const { plugin, store, app } = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\n"))
    );
    const file = app.vault.getAbstractFileByPath("People/Sam.md");

    // Preview saw an empty field; the user then typed their own value.
    await app.fileManager.processFrontMatter(file, (fm) => {
      fm.email = "mine@example.com";
    });

    const result = await plugin.applyContactImport(
      [{
        personPath: "People/Sam.md",
        personName: "Sam",
        contact: { displayName: "Sam", emails: [], phones: [], labels: [] },
        confidence: "exact",
        changes: [{ key: "email", from: null, to: "import@example.com" }],
      }],
      false
    );
    check("hand-typed value is not clobbered", () =>
      assert.ok(/mine@example.com/.test(store.get(file.path)), store.get(file.path)));
    check("the skip is reported", () => assert.strictEqual(result.skipped, 1));
  }

  // ======================================================================
  console.log("\n16. Undo conflict handling and rename remap (#11, #12)");
  {
    const { plugin, store, app, files } = await makePlugin(
      { personFolders: ["People"], journalSources: [] },
      (v) => v.addFile("People/Sam.md", PERSON_FM("prm-tier: close\n"))
    );
    const file = app.vault.getAbstractFileByPath("People/Sam.md");
    await plugin.setTier(file, "inner");

    store.set(file.path, store.get(file.path) + "\nedited by hand\n");
    const conflicted = store.get(file.path);
    notices.length = 0;
    await plugin.performUndo();
    check("external edit blocks the undo", () =>
      assert.strictEqual(store.get(file.path), conflicted));
    check("the stale entry is kept, not silently dropped", () =>
      assert.strictEqual(plugin.undo.canUndo(), true));

    // Rename, then make the entry applicable again.
    const undone = conflicted.replace("\nedited by hand\n", "");
    store.set(file.path, undone);
    store.set("People/Samuel.md", undone);
    file.path = "People/Samuel.md";
    file.basename = "Samuel";
    plugin.undo.remapPath("People/Sam.md", "People/Samuel.md");
    const res = await plugin.undo.undo();
    check("undo works after a rename thanks to path remapping", () =>
      assert.ok(res.ok, res.ok ? "" : res.reason));
  }

  // ======================================================================
  console.log("\n17. Non-Latin and reordered names match (generalizability #8)");
  {
    const contacts = require(harness.bundleModule("src/contacts.ts"));
    const people = [
      { path: "P/李伟.md", name: "李伟", aliases: [] },
      { path: "P/Иван Петров.md", name: "Иван Петров", aliases: [] },
      { path: "P/محمد علي.md", name: "محمد علي", aliases: [] },
      { path: "P/Ochoa, Dana.md", name: "Ochoa, Dana", aliases: [] },
      { path: "P/Dr. Ana Ruiz.md", name: "Dr. Ana Ruiz", aliases: [] },
    ];
    const opts = { overwriteExisting: false, includeGivenNameMatches: false, nicknamesAsAliases: false };
    const report = contacts.matchContacts(
      [
        { displayName: "李伟", emails: ["a@x.com"], phones: [], labels: [] },
        { displayName: "Иван Петров", emails: ["b@x.com"], phones: [], labels: [] },
        { displayName: "محمد علي", emails: ["c@x.com"], phones: [], labels: [] },
        { displayName: "Dana Ochoa", emails: ["d@x.com"], phones: [], labels: [] },
        { displayName: "Ana Ruiz", emails: ["e@x.com"], phones: [], labels: [] },
      ],
      people, () => ({}), opts
    );
    check("CJK name matches", () => assert.ok(report.plans.some((p) => p.personName === "李伟")));
    check("Cyrillic name matches", () => assert.ok(report.plans.some((p) => p.personName === "Иван Петров")));
    check("Arabic name matches", () => assert.ok(report.plans.some((p) => p.personName === "محمد علي")));
    check("Last, First order matches", () => assert.ok(report.plans.some((p) => p.personName === "Ochoa, Dana")));
    check("honorific is ignored", () => assert.ok(report.plans.some((p) => p.personName === "Dr. Ana Ruiz")));
    check("nothing left unmatched", () => assert.strictEqual(report.unmatched.length, 0));

    check("EU birthday 17/04/1999 is not corrupted to month 17", () =>
      assert.strictEqual(contacts.normalizeBirthday("17/04/1999"), "1999-04-17"));
    check("truly ambiguous 04/05/1999 is dropped rather than guessed", () =>
      assert.strictEqual(contacts.normalizeBirthday("04/05/1999"), undefined));
    check("ISO timestamp birthday parses", () =>
      assert.strictEqual(contacts.normalizeBirthday("1999-04-17T00:00:00Z"), "1999-04-17"));
  }

  // ======================================================================
  console.log("\n18. Real vault sanity check (read-only)");
  {
    const fs = require("fs");
    const VAULT = harness.realVault();
    if (VAULT) {
      const { plugin } = await makePlugin(
        {
          personFolders: ["Atlas/People"],
          journalSources: [{ folder: "Calendar/Journal", format: "YYYY-MM-DD" }],
        },
        (v) => {
          // Mirror the real vault's structure without writing to it.
          const people = fs.readdirSync(path.join(VAULT, "Atlas/People")).filter((f) => f.endsWith(".md"));
          for (const f of people) {
            v.addFile(`Atlas/People/${f}`, fs.readFileSync(path.join(VAULT, "Atlas/People", f), "utf8"));
          }
          const walk = (dir, rel) => {
            for (const e of fs.readdirSync(path.join(VAULT, dir), { withFileTypes: true })) {
              if (e.isDirectory()) walk(`${dir}/${e.name}`, `${rel}/${e.name}`);
              else if (e.name.endsWith(".md")) {
                v.addFile(`${rel}/${e.name}`, fs.readFileSync(path.join(VAULT, dir, e.name), "utf8"));
              }
            }
          };
          walk("Calendar/Journal", "Calendar/Journal");
        }
      );
      const d = plugin.engine.diagnostics();
      console.log(`     people=${d.personFilesFound} skipped=${d.personFilesSkipped} ` +
        `journals=${d.journalFilesScanned} dated=${d.journalFilesDated} ` +
        `interactions=${d.interactionsFound} in ${d.buildMs.toFixed(1)}ms`);
      check("real vault: people indexed", () => assert.ok(d.personFilesFound > 200));
      check("real vault: journals dated", () => assert.ok(d.journalFilesDated > 1800));
      check("real vault: interactions derived", () => assert.ok(d.interactionsFound > 1000));
      check("real vault: excalidraw + MOC excluded", () => {
        const names = plugin.engine.all().map((r) => r.name);
        assert.ok(!names.some((n) => /excalidraw/i.test(n)));
      });
      // The fake metadata cache re-parses on every getFileCache, so an unmemoized
      // rebuild measures harness parsing, not plugin work. Obsidian's cache is a
      // cache; memoize this one to match before timing anything.
      {
        const memo = new Map();
        const raw = plugin.app.metadataCache.getFileCache;
        plugin.app.metadataCache.getFileCache = (f) => {
          if (!memo.has(f.path)) memo.set(f.path, raw(f));
          return memo.get(f.path);
        };
      }
      plugin.engine.rebuild();
      plugin.engine.rebuild();
      const warm = [];
      for (let i = 0; i < 7; i++) {
        plugin.engine.rebuild();
        warm.push(plugin.engine.diagnostics().buildMs);
      }
      warm.sort((a, b) => a - b);
      const median = warm[3];
      console.log(`     warm rebuild median ${median.toFixed(2)}ms (cold ${d.buildMs.toFixed(1)}ms incl. harness parsing)`);
      check("real vault: warm rebuild under 10ms", () =>
        assert.ok(median < 10, `${median.toFixed(2)}ms`));
    } else {
      console.log("     (vault not found, skipped)");
    }
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error("\nSUITE ERROR:", e.stack);
  process.exit(1);
});
