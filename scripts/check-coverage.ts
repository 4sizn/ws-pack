/**
 * Run the unit/contract test suite with coverage and enforce an aggregate floor.
 *
 * Bun 1.4.2 checks `coverageThreshold` against every file individually
 * (oven-sh/bun#17028), so a global aggregate floor cannot be expressed in
 * bunfig.toml alone. This script parses the "All files" row from the text
 * coverage report and fails the build when the aggregate drops below the
 * pinned floor.
 */

const LINES_FLOOR = 85;
const FUNCS_FLOOR = 62;

const proc = Bun.spawn(["bun", "test", "./test", "--coverage"], {
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
const exitCode = await proc.exited;

// Always print the test/coverage output so the report is visible in CI.
console.log(stderr + stdout);

if (exitCode !== 0) {
  process.exit(exitCode);
}

const combined = stderr + stdout;
const outputLines = combined.split("\n");
const allFilesLine = outputLines.find((line) => line.includes("All files"));

if (!allFilesLine) {
  console.error("Coverage gate: could not find the 'All files' row in the coverage report.");
  process.exit(1);
}

const parts = allFilesLine.split("|").map((part) => part.trim());
const funcsText = parts.at(-3);
const linesText = parts.at(-2);

if (!funcsText || !linesText) {
  console.error("Coverage gate: could not parse the 'All files' row.");
  process.exit(1);
}

const funcs = Number.parseFloat(funcsText);
const lines = Number.parseFloat(linesText);

if (Number.isNaN(funcs) || Number.isNaN(lines)) {
  console.error("Coverage gate: could not parse coverage percentages.");
  process.exit(1);
}

if (lines < LINES_FLOOR || funcs < FUNCS_FLOOR) {
  console.error(
    `Coverage gate failed: aggregate coverage ${funcs.toFixed(2)}% funcs / ${lines.toFixed(2)}% lines is below the floor ${FUNCS_FLOOR}% funcs / ${LINES_FLOOR}% lines.`,
  );
  process.exit(1);
}

console.log(
  `Coverage gate passed: ${funcs.toFixed(2)}% funcs / ${lines.toFixed(2)}% lines (floor ${FUNCS_FLOOR}% funcs / ${LINES_FLOOR}% lines).`,
);
