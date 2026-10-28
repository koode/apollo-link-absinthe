/**
 * Conventional Commits, as the history is written: a type from
 * config-conventional, a header of at most 100 characters and a subject that
 * starts in lowercase. Names such as GraphQL or Phoenix may appear later in the
 * subject, so the stock subject-case rule alone is not enough.
 *
 * Long body and footer lines only warn: Dependabot writes release-note links
 * and a YAML footer that run past 100 characters.
 */
const config = {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        /** @param {{ subject: string | null }} commit the parsed commit message */
        "subject-lowercase-start": ({ subject }) => [
          subject === null || !/^[A-Z]/u.test(subject),
          "subject must not start with an uppercase letter",
        ],
      },
    },
  ],
  rules: {
    "header-max-length": [2, "always", 100],
    "subject-lowercase-start": [2, "always"],
    "body-max-line-length": [1, "always", 100],
    "footer-max-line-length": [1, "always", 100],
  },
};

export default config;
