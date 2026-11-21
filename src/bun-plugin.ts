// spokeshave as a Bun.build plugin: bundle with Bun, then minify each emitted
// JavaScript file with the portfolio.
//
//   await Bun.build({ entrypoints, outdir: "dist", minify: false, plugins: [spokeshave()] });
//
// Bun's plugin API has no hook that rewrites an output in memory: onEnd gets
// the finished BuildOutput, whose artifacts are read-only Blobs. So this plugin
// needs `outdir`, and rewrites the files Bun already wrote there. It also
// refuses `minify: true` (Bun would minify first and spokeshave would minify
// Bun's output) and source maps (the rewritten file would no longer match its
// map). Both are limits of this adapter, not of the portfolio.
import type { BunPlugin } from "bun";
import { minify } from "./index.ts";
import type { Pipeline } from "./index.ts";

export type PluginOptions = {
  pipelines?: readonly Pipeline[];
  markers?: readonly string[];
};

export const spokeshave = (options: PluginOptions = {}): BunPlugin => ({
  name: "spokeshave",
  setup(build) {
    const config = build.config;
    if (config.minify)
      throw new Error(
        "spokeshave: set minify: false; the plugin minifies Bun's unminified output",
      );
    if (config.sourcemap !== undefined && config.sourcemap !== "none")
      throw new Error(
        "spokeshave: source maps are not supported yet; the minified file would not match its map",
      );
    if (!config.outdir)
      throw new Error(
        "spokeshave: needs outdir, because Bun's onEnd hook can only rewrite files already on disk",
      );
    build.onEnd(async (result) => {
      if (!result.success) return;
      for (const output of result.outputs) {
        if (
          (output.kind !== "entry-point" && output.kind !== "chunk") ||
          !output.path.endsWith(".js")
        )
          continue;
        const source = await Bun.file(output.path).text();
        const minified = await minify(source, {
          filename: output.path,
          kind:
            config.format === "iife" || config.format === "cjs"
              ? "script"
              : "module",
          pipelines: options.pipelines,
          markers: options.markers,
        });
        await Bun.write(output.path, minified.code);
      }
    });
  },
});
