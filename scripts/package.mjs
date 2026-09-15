import { copyFile, mkdir, readFile, cp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

const execFileAsync = promisify(execFile);
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
if (process.platform === "win32") {
  const zip = resolve(root, `Synovia-${pkg.version}.zip`);
  const tempZip = resolve(root, `.Synovia-${pkg.version}.${process.pid}.zip`);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Compress-Archive -Path '${dist.replaceAll("'", "''")}\\synovia' -DestinationPath '${tempZip.replaceAll("'", "''")}' -CompressionLevel Optimal`,
    `[System.IO.File]::Copy('${tempZip.replaceAll("'", "''")}', '${zip.replaceAll("'", "''")}', $true)`,
    `[System.IO.File]::Delete('${tempZip.replaceAll("'", "''")}')`,
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
  console.log(`Delivery archive ready: ${relative(root, zip)}`);
}
