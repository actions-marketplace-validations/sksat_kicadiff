import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

/**
 * Playwright global setup: generate test fixtures using render.sh
 * against the PicoBridge PCB file. The output is used by viewer tests.
 */
export default function globalSetup() {
  const projectDir = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(projectDir, "..");
  const fixtureDir = path.join(projectDir, "test", "fixtures");
  const kicadFile = path.join(
    repoRoot,
    "PicoBridge",
    "pcb",
    "PicoBridge.kicad_pcb"
  );

  // Skip if KiCad file doesn't exist (CI without KiCad data)
  if (!fs.existsSync(kicadFile)) {
    console.log(
      "Skipping fixture generation: KiCad file not found at",
      kicadFile
    );
    return;
  }

  // Generate fixtures (idempotent — overwrites existing)
  console.log("Generating test fixtures with render.sh...");
  execSync(
    `bash "${path.join(projectDir, "render.sh")}" "${kicadFile}" --output-dir "${fixtureDir}"`,
    {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 60000,
    }
  );
  console.log("Fixtures generated at", fixtureDir);
}
