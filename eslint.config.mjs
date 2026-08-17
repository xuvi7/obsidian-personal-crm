import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "dist/**", "node_modules/**", "*.mjs"] },
  ...tseslint.configs.recommendedTypeChecked,
  ...(obsidianmd.configs?.recommended ?? []),
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Obsidian's sentence-case convention is followed, but this rule implements
      // it by lowercasing every word after the first. That mangles acronyms
      // ("Personal CRM" -> "Personal crm"), proper nouns ("Google Contacts",
      // "Daily Notes", "vCard"), format strings ("YYYY-MM-DD"), the pronoun "I",
      // and placeholders that mirror literal frontmatter keys (`type`, `date`).
      // Every one of its 20 reports here was such a case, so it is off by intent.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
);
