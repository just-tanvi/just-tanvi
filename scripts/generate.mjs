// generate.mjs
// Fetches a GitHub user's contribution calendar and renders an animated
// SVG where Mario runs across the grid, jumping onto "active" (green) cells
// and passing/falling under "inactive" (dark) ones.
//
// Usage:
//   node scripts/generate.mjs <github-username> [outfile]
//
// No GitHub token required — uses the public contributions API mirror
// (https://github-contributions-api.jogruber.de), the same data source
// many "contribution graph" tools use.

import fs from "fs";

const username = process.argv[2];
const outfile = process.argv[3] || "mario.svg";

if (!username) {
  console.error("Usage: node generate.mjs <github-username> [outfile]");
  process.exit(1);
}

const CELL = 12;        // cell size (matches GitHub's graph roughly)
const GAP = 3;          // gap between cells
const STEP = CELL + GAP;
const PADDING_TOP = 30; // room for Mario's jump arc above row 0
const PADDING_LEFT = 20;
const PADDING_BOTTOM = 10;

const LEVEL_COLORS = {
  0: "#161b22", // inactive / no contributions -> "black" tile, not landable
  1: "#0e4429",
  2: "#006d32",
  3: "#26a641",
  4: "#39d353", // most active -> brightest green
};

async function fetchContributions(user) {
  const url = `https://github-contributions-api.jogruber.de/v4/${user}?y=last`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch contributions for ${user}: ${res.status}`);
  }
  const data = await res.json();
  // data.contributions: [{ date, count, level }]
  return data.contributions;
}

// Reshape a flat list of days into GitHub's week-column grid (7 rows x N weeks),
// aligned so Sunday = row 0, same as the real graph.
function toWeekGrid(days) {
  const weeks = [];
  let currentWeek = new Array(7).fill(null);

  days.forEach((day) => {
    const date = new Date(day.date + "T00:00:00Z");
    const dow = date.getUTCDay(); // 0 = Sunday
    if (dow === 0 && currentWeek.some((d) => d !== null)) {
      weeks.push(currentWeek);
      currentWeek = new Array(7).fill(null);
    }
    currentWeek[dow] = day;
  });
  if (currentWeek.some((d) => d !== null)) weeks.push(currentWeek);
  return weeks;
}

function buildSvg(weeks, user) {
  const numWeeks = weeks.length;
  const width = PADDING_LEFT * 2 + numWeeks * STEP;
  const height = PADDING_TOP + 7 * STEP + PADDING_BOTTOM;

  // Flatten into a path-order list: week by week, top (Sunday) to bottom (Saturday),
  // matching how Mario will traverse left -> right, hopping down/up rows only
  // when needed to land on green cells. To keep it simple & readable, Mario
  // runs along ONE horizontal "lane" per loop and we pick, for each week column,
  // the most active day to determine jump height -- this keeps the animation
  // readable instead of a chaotic 7-row scramble.
  const cells = [];
  weeks.forEach((week, wi) => {
    // pick the day in this week with the highest level (most "active") as the
    // platform Mario lands on; if all zero, it's a gap he runs/falls past.
    let best = null;
    week.forEach((day) => {
      if (day && (best === null || day.level > best.level)) best = day;
    });
    cells.push({
      x: PADDING_LEFT + wi * STEP,
      level: best ? best.level : 0,
      date: best ? best.date : null,
      count: best ? best.count : 0,
    });
  });

  const groundY = PADDING_TOP + 7 * STEP; // baseline Mario runs along when not jumping
  const jumpHeight = 26;

  // Build the little ground/cell squares (the real contribution-style grid,
  // collapsed to one row per week using the "best day" level so it doubles
  // as Mario's track).
  const cellRects = cells
    .map((c) => {
      const y = groundY - CELL;
      const landable = c.level > 0;
      return `<rect x="${c.x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${LEVEL_COLORS[c.level]}" stroke="${landable ? "#2ea043" : "#30363d"}" stroke-width="0.5">${c.date ? `<title>${c.date}: ${c.count} contributions</title>` : ""}</rect>`;
    })
    .join("\n    ");

  // Animation timeline: Mario moves from cell to cell. For landable (green)
  // cells he arcs upward (jump) and lands on top of the tile. For inactive
  // (level 0 / "black") cells he just runs straight through at ground level
  // (can't land there).
  const totalDuration = Math.max(numWeeks * 0.45, 6); // seconds, scales with weeks
  const stepDur = totalDuration / numWeeks;

  const xKeyTimes = [];
  const xValues = [];
  const yValues = [];

  cells.forEach((c, i) => {
    const t = i / numWeeks;
    const landable = c.level > 0;
    const standY = groundY - (landable ? CELL : 0); // top of tile or ground line
    const peakY = standY - jumpHeight;

    xKeyTimes.push(t.toFixed(4));
    xValues.push(c.x);
    yValues.push(standY);

    if (landable) {
      // add an apex point just before reaching this cell, to create the hop arc
      const tApex = Math.max(t - (1 / numWeeks) * 0.4, 0);
      xKeyTimes.push(tApex.toFixed(4));
      xValues.push(c.x - STEP * 0.4);
      yValues.push(peakY);
    }
  });

  // sort all keyframes by time while keeping x/y paired
  const combined = xKeyTimes
    .map((t, i) => ({ t: parseFloat(t), x: xValues[i], y: yValues[i] }))
    .sort((a, b) => a.t - b.t);

  // de-dup identical times, ensure starts at 0 and ends at 1
  const seen = new Set();
  const frames = [];
  combined.forEach((f) => {
    const key = f.t.toFixed(4);
    if (!seen.has(key)) {
      seen.add(key);
      frames.push(f);
    }
  });
  if (frames[0].t !== 0) frames.unshift({ t: 0, x: frames[0].x, y: frames[0].y });
  if (frames[frames.length - 1].t !== 1) {
    const last = frames[frames.length - 1];
    frames.push({ t: 1, x: last.x, y: last.y });
  }

  const keyTimes = frames.map((f) => f.t.toFixed(4)).join(";");
  const xVals = frames.map((f) => f.x.toFixed(1)).join(";");
  const yVals = frames.map((f) => f.y.toFixed(1)).join(";");

  // Simple 16x16-ish blocky Mario built from rects (no external assets,
  // renders anywhere GitHub displays SVG).
  const mario = `
  <g id="mario">
    <!-- cap -->
    <rect x="-6" y="-16" width="12" height="4" fill="#e4000f"/>
    <rect x="-7" y="-13" width="14" height="3" fill="#e4000f"/>
    <!-- face -->
    <rect x="-5" y="-10" width="10" height="6" fill="#fcb38a"/>
    <!-- mustache/eyes -->
    <rect x="-5" y="-7" width="10" height="2" fill="#3a2412"/>
    <!-- body (overalls) -->
    <rect x="-6" y="-4" width="12" height="6" fill="#0058f8"/>
    <rect x="-6" y="-10" width="3" height="3" fill="#e4000f"/>
    <rect x="3" y="-10" width="3" height="3" fill="#e4000f"/>
    <!-- legs -->
    <rect x="-6" y="2" width="5" height="4" fill="#3a2412"/>
    <rect x="1" y="2" width="5" height="4" fill="#3a2412"/>
  </g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica,Arial,sans-serif">
  <style>
    text { fill: #8b949e; font-size: 9px; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>

  <!-- contribution-style track -->
  <g>
    ${cellRects}
  </g>

  <!-- ground line -->
  <line x1="${PADDING_LEFT - 4}" y1="${groundY}" x2="${width - PADDING_LEFT + 4}" y2="${groundY}" stroke="#30363d" stroke-width="1"/>

  <!-- Mario -->
  <g transform="translate(${frames[0].x},${frames[0].y})">
    ${mario}
    <animateTransform attributeName="transform" type="translate"
      values="${frames.map((f) => `${f.x.toFixed(1)},${f.y.toFixed(1)}`).join(";")}"
      keyTimes="${keyTimes}"
      dur="${totalDuration}s"
      repeatCount="indefinite"
      calcMode="linear"/>
  </g>

  <text x="${PADDING_LEFT}" y="${height - 1}">@${user} —  watch mario parkour !</text>
</svg>`;

  return svg;
}

(async () => {
  try {
    const days = await fetchContributions(username);
    const weeks = toWeekGrid(days);
    const svg = buildSvg(weeks, username);
    fs.writeFileSync(outfile, svg);
    console.log(`Wrote ${outfile} (${weeks.length} weeks)`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
