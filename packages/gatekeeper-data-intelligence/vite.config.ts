// Vite+ per-package settings: only the shared vitest `test` task. There is no configurator UI to
// build; `build` is the `tsc` script in package.json.
import vitestTaskViteConfig from "../../scripts/vitest-task-vite-config.js";

export default vitestTaskViteConfig("vitest run");
