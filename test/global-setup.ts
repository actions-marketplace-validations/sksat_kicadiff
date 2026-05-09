import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

/**
 * Playwright global setup: generate test fixtures using kicadiff CLI
 * against the PicoBridge PCB file (and schematic if present).
 */
export default function globalSetup() {
  const projectDir = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(projectDir, "..");
  const fixtureDir = path.join(projectDir, "test", "fixtures");
  const kicadCli = path.join(projectDir, "kicadiff");

  const pcbFile = path.join(repoRoot, "PicoBridge", "pcb", "PicoBridge.kicad_pcb");
  const schFile = path.join(repoRoot, "PicoBridge", "pcb", "PicoBridge.kicad_sch");

  if (!fs.existsSync(pcbFile)) {
    console.log("Skipping fixture generation: KiCad file not found at", pcbFile);
    return;
  }

  console.log("Generating PCB fixtures...");
  execSync(`bash "${kicadCli}" pcb "${pcbFile}" --output-dir "${fixtureDir}"`, {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 60000,
  });

  if (fs.existsSync(schFile)) {
    console.log("Generating schematic fixtures...");
    execSync(`bash "${kicadCli}" sch "${schFile}" --output-dir "${fixtureDir}"`, {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 60000,
    });
  }

  console.log("Fixtures generated at", fixtureDir);
}
