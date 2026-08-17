/**
 * Print the CHANGELOG section for one version, without its heading.
 *
 * Release notes should describe that release, not repeat the project's whole
 * history. Exits non-zero when the version has no section, so a release can't be
 * cut without a changelog entry.
 */
import fs from "node:fs";

const version = process.argv[2];
if (!version) {
	console.error("usage: changelog-section.mjs <version>");
	process.exit(2);
}

const lines = fs.readFileSync("CHANGELOG.md", "utf8").split("\n");
const heading = new RegExp(`^##\\s+${version.replace(/\./g, "\\.")}(?:\\s|$)`);

const start = lines.findIndex((l) => heading.test(l));
if (start === -1) {
	console.error(`No CHANGELOG.md section for ${version}. Add one before releasing.`);
	process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
	if (/^##\s/.test(lines[i])) {
		end = i;
		break;
	}
}

const body = lines.slice(start + 1, end).join("\n").trim();
if (body.length === 0) {
	console.error(`The CHANGELOG.md section for ${version} is empty.`);
	process.exit(1);
}
process.stdout.write(`${body}\n`);
