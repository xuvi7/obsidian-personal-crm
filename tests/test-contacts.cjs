const harness = require("./build.cjs");
const assert = require("assert");
const C = require(harness.bundleModule("src/contacts.ts"));

let passed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); process.exitCode = 1; }
}

console.log("\nGoogle CSV (modern export)");

const modernCsv = [
  'First Name,Middle Name,Last Name,Nickname,Organization Name,Organization Title,Birthday,Address 1 - City,Address 1 - Region,Labels,E-mail 1 - Value,E-mail 2 - Value,Phone 1 - Value',
  'Dana,,Ochoa,Dee,Initech,Software Engineer,--08-04,Boston,MA,* myContacts ::: Interns,dana@example.com,dochoa@work.com,+1 555-555-0100',
  '"Song, Cynthia",,,,,,1999-04-17,,,,cynthia@example.com,,',
  'Nicholas,,Xu,,,,,,,,,,+1 555-0199',
].join("\n");

const modern = C.parseGoogleCsv(modernCsv);

check("parses all rows", () => assert.strictEqual(modern.length, 3));

check("builds display name from parts", () =>
  assert.strictEqual(modern[0].displayName, "Dana Ochoa"));

check("collects multiple email columns", () =>
  assert.deepStrictEqual(modern[0].emails, ["dana@example.com", "dochoa@work.com"]));

check("reads nickname, org, title", () => {
  assert.strictEqual(modern[0].nickname, "Dee");
  assert.strictEqual(modern[0].company, "Initech");
  assert.strictEqual(modern[0].title, "Software Engineer");
});

check("year-less birthday --08-04 -> 08-04", () =>
  assert.strictEqual(modern[0].birthday, "08-04"));

check("joins city and region", () =>
  assert.strictEqual(modern[0].location, "Boston, MA"));

check("strips myContacts from labels", () =>
  assert.deepStrictEqual(modern[0].labels, ["Interns"]));

check("quoted field containing a comma stays intact", () =>
  assert.strictEqual(modern[1].displayName, "Song, Cynthia"));

check("full-date birthday preserved", () =>
  assert.strictEqual(modern[1].birthday, "1999-04-17"));

check("row with only a phone still parses", () => {
  assert.strictEqual(modern[2].displayName, "Nicholas Xu");
  assert.deepStrictEqual(modern[2].phones, ["+1 555-0199"]);
  assert.strictEqual(modern[2].birthday, undefined);
});

console.log("\nGoogle CSV (legacy export)");

const legacyCsv = [
  'Name,Given Name,Family Name,E-mail 1 - Value,Phone 1 - Value,Group Membership',
  'Gordon Jin,Gordon,Jin,gordon@example.com ::: gordon2@example.com,555-0123,Friends ::: My Contacts',
].join("\n");

const legacy = C.parseGoogleCsv(legacyCsv);
check("legacy headers recognised", () => {
  assert.strictEqual(legacy.length, 1);
  assert.strictEqual(legacy[0].displayName, "Gordon Jin");
});
check("::: splits multiple values in one cell", () =>
  assert.deepStrictEqual(legacy[0].emails, ["gordon@example.com", "gordon2@example.com"]));
check("My Contacts filtered from group membership", () =>
  assert.deepStrictEqual(legacy[0].labels, ["Friends"]));

console.log("\nvCard");

const vcf = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Almendral;Jillian;;;",
  "FN:Jillian Almendral",
  "NICKNAME:Jill",
  "EMAIL;TYPE=INTERNET;TYPE=HOME:jillian@example.com",
  "item1.EMAIL;TYPE=INTERNET:jill@work.com",
  "TEL;TYPE=CELL:+1 555-0142",
  "BDAY:19990417",
  "ORG:Initech;Engineering",
  "TITLE:Intern",
  "ADR;TYPE=HOME:;;123 Long Street Name That Wraps;Providence;RI;02906;USA",
  "NOTE:met at orientation",
  "CATEGORIES:myContacts,Brown",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Folded Name",
  "EMAIL:folded",
  " @example.com",
  "END:VCARD",
].join("\r\n");

const cards = C.parseVCard(vcf);
check("parses both cards", () => assert.strictEqual(cards.length, 2));
check("FN wins as display name", () =>
  assert.strictEqual(cards[0].displayName, "Jillian Almendral"));
check("N splits family/given", () => {
  assert.strictEqual(cards[0].lastName, "Almendral");
  assert.strictEqual(cards[0].firstName, "Jillian");
});
check("grouped item1.EMAIL collected", () =>
  assert.deepStrictEqual(cards[0].emails, ["jillian@example.com", "jill@work.com"]));
check("BDAY 19990417 normalised", () =>
  assert.strictEqual(cards[0].birthday, "1999-04-17"));
check("ORG takes first component", () =>
  assert.strictEqual(cards[0].company, "Initech"));
check("ADR yields locality, region", () =>
  assert.strictEqual(cards[0].location, "Providence, RI"));
check("CATEGORIES drops myContacts", () =>
  assert.deepStrictEqual(cards[0].labels, ["Brown"]));
check("line folding rejoined", () =>
  assert.deepStrictEqual(cards[1].emails, ["folded@example.com"]));

check("parseContactsFile sniffs vCard without extension", () =>
  assert.strictEqual(C.parseContactsFile("export.txt", vcf).length, 2));
check("parseContactsFile defaults to CSV", () =>
  assert.strictEqual(C.parseContactsFile("contacts.csv", modernCsv).length, 3));

console.log("\nBirthday normalisation");
for (const [input, expected] of [
  ["1999-04-17", "1999-04-17"],
  ["19990417", "1999-04-17"],
  ["--04-17", "04-17"],
  ["--0417", "04-17"],
  ["4/17/1999", "1999-04-17"],
  ["", undefined],
  ["nonsense", undefined],
]) {
  check(`${JSON.stringify(input)} -> ${expected}`, () =>
    assert.strictEqual(C.normalizeBirthday(input), expected));
}

console.log("\nMatching");

const people = [
  { path: "Atlas/People/Dana Ochoa.md", name: "Dana Ochoa", aliases: [] },
  { path: "Atlas/People/Alex McNally.md", name: "Alex McNally", aliases: ["Alex"] },
  { path: "Atlas/People/Alex Nguyen.md", name: "Alex Nguyen", aliases: ["Alex"] },
  { path: "Atlas/People/Adarsh.md", name: "Adarsh", aliases: [] },
  { path: "Atlas/People/Rene Descartes.md", name: "René Descartes", aliases: [] },
];

const noFm = () => ({});
const baseOpts = { overwriteExisting: false, includeGivenNameMatches: false, nicknamesAsAliases: false };

const r1 = C.matchContacts(
  [
    { displayName: "Dana Ochoa", emails: ["j@x.com"], phones: [], labels: [] },
    { displayName: "Alex", emails: ["a@x.com"], phones: [], labels: [] },
    { displayName: "Nobody Here", emails: ["n@x.com"], phones: [], labels: [] },
    { displayName: "Rene Descartes", emails: ["r@x.com"], phones: [], labels: [] },
    { displayName: "Adarsh Kumar", firstName: "Adarsh", emails: ["ak@x.com"], phones: [], labels: [] },
  ],
  people, noFm, baseOpts,
);

check("exact name match", () => {
  const p = r1.plans.find((p) => p.personName === "Dana Ochoa");
  assert.ok(p, "Dana Ochoa should match");
  assert.strictEqual(p.confidence, "exact");
});

check("alias shared by two people is ambiguous, not applied", () => {
  assert.ok(r1.ambiguous.some((a) => a.contact.displayName === "Alex"));
  assert.ok(!r1.plans.some((p) => p.personName.startsWith("Alex")));
});

check("diacritics normalised (Rene -> René)", () =>
  assert.ok(r1.plans.some((p) => p.personName === "René Descartes")));

check("given-name match excluded by default", () => {
  assert.ok(r1.unmatched.some((c) => c.displayName === "Adarsh Kumar"));
  assert.ok(!r1.plans.some((p) => p.personName === "Adarsh"));
});

check("no match reported as unmatched", () =>
  assert.ok(r1.unmatched.some((c) => c.displayName === "Nobody Here")));

const r2 = C.matchContacts(
  [{ displayName: "Adarsh Kumar", firstName: "Adarsh", emails: ["ak@x.com"], phones: [], labels: [] }],
  people, noFm, { ...baseOpts, includeGivenNameMatches: true },
);
check("given-name match applied when enabled", () => {
  assert.strictEqual(r2.plans.length, 1);
  assert.strictEqual(r2.plans[0].personName, "Adarsh");
  assert.strictEqual(r2.plans[0].confidence, "given-name");
});

const r3 = C.matchContacts(
  [
    { displayName: "Dana Ochoa", emails: ["one@x.com"], phones: [], labels: [] },
    { displayName: "Dana Ochoa", emails: ["two@x.com"], phones: [], labels: [] },
  ],
  people, noFm, baseOpts,
);
check("two contacts for one note: second flagged, not silently overwriting", () => {
  assert.strictEqual(r3.plans.length, 1);
  assert.strictEqual(r3.ambiguous.length, 1);
});

console.log("\nChange planning");

const contact = {
  displayName: "Dana Ochoa",
  nickname: "Dee",
  emails: ["dana@example.com"],
  phones: ["555-0100"],
  company: "Initech",
  birthday: "08-04",
  labels: [],
};

check("fills empty fields", () => {
  const changes = C.planChanges(contact, {}, baseOpts);
  const keys = changes.map((c) => c.key).sort();
  assert.deepStrictEqual(keys, ["company", "email", "phone", "prm-birthday"]);
  assert.strictEqual(changes.find((c) => c.key === "email").to, "dana@example.com");
});

check("existing value protected when overwrite is off", () => {
  const changes = C.planChanges(contact, { email: "mine@example.com" }, baseOpts);
  assert.ok(!changes.some((c) => c.key === "email"));
});

check("existing value replaced when overwrite is on", () => {
  const changes = C.planChanges(contact, { email: "mine@example.com" },
    { ...baseOpts, overwriteExisting: true });
  const email = changes.find((c) => c.key === "email");
  assert.strictEqual(email.from, "mine@example.com");
  assert.strictEqual(email.to, "dana@example.com");
});

check("identical value produces no change", () => {
  const changes = C.planChanges(contact, { email: "dana@example.com" },
    { ...baseOpts, overwriteExisting: true });
  assert.ok(!changes.some((c) => c.key === "email"));
});

check("nickname merges into existing aliases, never replaces", () => {
  const changes = C.planChanges(contact, { aliases: ["Jaybee"] },
    { ...baseOpts, nicknamesAsAliases: true });
  const aliases = changes.find((c) => c.key === "aliases");
  assert.deepStrictEqual(aliases.to, ["Jaybee", "Dee"]);
});

check("nickname already present is not duplicated", () => {
  const changes = C.planChanges(contact, { aliases: ["dee"] },
    { ...baseOpts, nicknamesAsAliases: true });
  assert.ok(!changes.some((c) => c.key === "aliases"));
});

check("multiple emails become an array", () => {
  const changes = C.planChanges({ ...contact, emails: ["a@x.com", "b@x.com"] }, {}, baseOpts);
  assert.deepStrictEqual(changes.find((c) => c.key === "email").to, ["a@x.com", "b@x.com"]);
});

console.log(`\n${passed} contact checks passed`);
