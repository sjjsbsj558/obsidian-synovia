import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: [
    "obsidian",
    "node:*",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  banner: { js: "/* Synovia: generated bundle. Edit src/, not this file. */" }
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
