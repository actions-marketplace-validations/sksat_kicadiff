import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright global setup: generate test fixtures using kicadiff CLI.
 *
 * Generates THREE fixture sets so each viewer test can target what it needs:
 *   - test/fixtures/combined/  : default mode (both PCB + sch in one HTML)
 *   - test/fixtures/pcb/       : pcb subcommand (PCB only)
 *   - test/fixtures/sch/       : sch subcommand (schematic only)
 */
export default function globalSetup() {
  // Belt-and-suspenders: ensure no test (or fixture-generation step) ever
  // spawns the real `code` / `xdg-open`, even if a future test forgets to
  // pass --open without an env override. Empty value = no-op in render.ts.
  if (process.env.KICADIFF_OPEN_CMD === undefined) {
    process.env.KICADIFF_OPEN_CMD = "";
  }

  const projectDir = path.resolve(__dirname, "..");
  const fixtureDir = path.join(projectDir, "test", "fixtures");
  const kicadCli = path.join(projectDir, "kicadiff");

  // Self-contained example used as the test fixture. Kept inside the kicadiff
  // project so tests don't require any sibling repo to be present.
  const projectFile = path.join(projectDir, "examples", "blink", "blink.kicad_pcb");
  const schFile = path.join(projectDir, "examples", "blink", "blink.kicad_sch");
  const repoRoot = path.resolve(projectDir, "..");

  if (!fs.existsSync(projectFile)) {
    console.log("Skipping fixture generation: KiCad file not found at", projectFile);
    return;
  }

  // Combined mode (no subcommand) — picks up both files when both exist
  console.log("Generating combined fixtures...");
  execSync(`"${kicadCli}" "${projectFile}" --output-dir "${path.join(fixtureDir, "combined")}"`, {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 90000,
  });

  // PCB-only fixture
  console.log("Generating PCB-only fixtures...");
  execSync(`"${kicadCli}" pcb "${projectFile}" --output-dir "${path.join(fixtureDir, "pcb")}"`, {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 60000,
  });

  // Schematic-only fixture (skip if no .kicad_sch)
  if (fs.existsSync(schFile)) {
    console.log("Generating schematic-only fixtures...");
    execSync(`"${kicadCli}" sch "${schFile}" --output-dir "${path.join(fixtureDir, "sch")}"`, {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 60000,
    });
  }

  console.log("Fixtures generated at", fixtureDir);
}
