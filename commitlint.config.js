// Conventional Commits — enforced because semantic-release reads commit
// history on `main` to decide the next version (feat -> minor, fix -> patch,
// "BREAKING CHANGE" / "!" -> major). See .github/workflows/release.yml.
export default {
  extends: ["@commitlint/config-conventional"],
};
