import { copyFile, mkdir, readFile, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
if (pkg.version !== manifest.version || versions[pkg.version] !== manifest.minAppVersion) {
  throw new Error("Package, manifest and versions.json must agree.");
}

const destination = new URL("../dist/synovia/", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
if (relative(root, dist) !== "dist") throw new Error("Package cleanup escaped the project.");
await rm(dist, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(file, destination));
}
console.log("Plugin package ready: dist/synovia/");
await cp(new URL("../skills/", import.meta.url), new URL("skills/", destination), { recursive: true });
