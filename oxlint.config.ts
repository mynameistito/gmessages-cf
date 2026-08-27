import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";

const jsPlugins = selectJsPlugins([]);

export default defineConfig({
  extends: [core, antiSlop, jsPlugins],
  ignorePatterns: [...(core.ignorePatterns ?? []), "gmessages/**"],
  jsPlugins: jsPlugins.jsPlugins,
});
